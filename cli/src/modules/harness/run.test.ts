import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { randomUUIDv7 } from "bun";
import { okAsync, errAsync } from "neverthrow";
import {
    AnalysisPlanSchema,
    makeLocalAuth,
    RunDedupCollisionError,
    type AnalysisPlan,
    type CortexRunRow,
    type ExecuteAnalysisInput,
    type RunSession,
    type RunStatus,
} from "@inflexa-ai/harness";

import { env } from "../../lib/env.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";
import { makeEmptyFarm } from "../libs/composition.ts";
import { describePlanPackageError, linkPlanPackages, triggerAnalysisRun, type RunTriggerSeams, type TriggerAnalysisRunParams } from "./run.ts";

// The run session the fake authorizer hands back — asserted by identity in the
// happy-path input check. Cast because the cli cannot construct a real one
// barrel-only, and `triggerAnalysisRun` only forwards it into the workflow input.
const RUN_SESSION = { marker: "run-session" } as unknown as RunSession;

// A DbError-shaped value for the non-collision reserve-failure path. Same literal
// shape the harness's `tryMutation` produces and that `plan_intake.test.ts` uses.
const DB_ERROR = { type: "mutation_failed", op: "runs.insertRun", cause: new Error("db down") } as const;

/** A two-step plan: T1S1 declares an agent + timeout; T1S2 declares neither (drives the map defaults). */
const PLAN = AnalysisPlanSchema.parse({
    title: "Differential expression",
    analytical_narrative: "Explore the dataset and quantify differences between the groups.",
    created_at: "2026-07-03T00:00:00.000Z",
    steps: [
        {
            id: "T1S1",
            name: "one",
            track: "T1",
            step_type: "analysis",
            question: "q1",
            acceptance_criteria: ["a"],
            depends_on: [],
            maxSteps: 8,
            resources: { cpu: 2, memoryGb: 4 },
            agent: "scientific-executor",
            timeout: 120,
        },
        {
            id: "T1S2",
            name: "two",
            track: "T1",
            step_type: "analysis",
            question: "q2",
            acceptance_criteria: ["b"],
            depends_on: ["T1S1"],
            maxSteps: 8,
            resources: { cpu: 1, memoryGb: 2 },
        },
    ],
});

const PARAMS: TriggerAnalysisRunParams = {
    auth: makeLocalAuth(),
    analysisId: "an-1",
    planId: "pln-abc12345",
    planSummary: "Differential expression",
    plan: PLAN,
};

/** A `cortex_runs` row fixture; override the fields a test cares about. */
function runRow(overrides: Partial<CortexRunRow> = {}): CortexRunRow {
    return {
        runId: "run-existing",
        analysisId: "an-1",
        threadId: null,
        workflowName: "executeAnalysis",
        status: "running",
        startedAt: "2026-07-03T00:00:00.000Z",
        completedAt: null,
        error: null,
        synthesisStatus: null,
        synthesisReason: null,
        parts: null,
        mandateJti: null,
        mandateExpiresAt: null,
        planId: "pln-abc12345",
        ...overrides,
    };
}

type Recorder = {
    queryActiveRun: number;
    insertRun: number;
    authorize: number;
    revoke: number;
    launch: number;
    updateRunStatus: Array<{ runId: string; status: RunStatus; error: string }>;
    launched: { input: ExecuteAnalysisInput; runId: string } | null;
};

/**
 * Recording seams whose behavior is driven by `behavior`. Every seam counts its
 * calls, so a test asserts a path was (or was NOT) taken — e.g. a dedup hit makes
 * no authorize/launch call. `activeRuns` is the successive `queryActiveRun`
 * returns (pre-check, then collision recovery); `insertThrows` models the
 * partial-unique collision (the real `insertRun` rejects, caught identically to a
 * sync throw); `insertErr` models a plain driver failure.
 */
function makeSeams(
    behavior: {
        activeRuns?: (CortexRunRow | null)[];
        insertThrows?: unknown;
        insertErr?: boolean;
        authorizeThrows?: unknown;
        launchThrows?: unknown;
    } = {},
): { seams: RunTriggerSeams; rec: Recorder } {
    const rec: Recorder = { queryActiveRun: 0, insertRun: 0, authorize: 0, revoke: 0, launch: 0, updateRunStatus: [], launched: null };
    const activeQueue = [...(behavior.activeRuns ?? [])];
    const seams: RunTriggerSeams = {
        queryActiveRun: () => {
            rec.queryActiveRun++;
            return okAsync(activeQueue.length > 0 ? (activeQueue.shift() ?? null) : null);
        },
        insertRun: () => {
            rec.insertRun++;
            if (behavior.insertThrows !== undefined) throw behavior.insertThrows;
            if (behavior.insertErr) return errAsync(DB_ERROR);
            return okAsync(undefined);
        },
        updateRunStatus: (runId, status, error) => {
            rec.updateRunStatus.push({ runId, status, error });
            return okAsync(undefined);
        },
        runAuthorizer: {
            authorize: async () => {
                rec.authorize++;
                if (behavior.authorizeThrows !== undefined) throw behavior.authorizeThrows;
                return { runSession: RUN_SESSION, ownsMandate: true };
            },
            revoke: async () => {
                rec.revoke++;
            },
        },
        launch: async (input, runId) => {
            rec.launch++;
            if (behavior.launchThrows !== undefined) throw behavior.launchThrows;
            rec.launched = { input, runId };
        },
        newRunId: () => "run-fixed",
        budget: { cpu: 4, memoryGb: 8 },
    };
    return { seams, rec };
}

// --- The package pass of a plan ------------------------------------------------

// The golden fixture pool of the composer. It is the ONE checked-in store that
// holds a graph, a pool, and both tracks, thus the package pass reads the same
// input the composer parity test reads.
const FIXTURE = join(import.meta.dir, "..", "libs", "test-fixtures", "farm-parity");

/** The path the sandbox mounts the store root at. A farm link bakes an absolute target beneath it. */
const MOUNT = "/mnt/libs";

const ALPHA = "alpha-1.2.0-000000000000aaaa";
const BETA = "beta-0.4.1-000000000000bbbb";
const GAMMA = "gamma-3.0.0-000000000000cccc";
const DELTA = "delta-0.9-000000000000dddd";
const TYPING = "typing-ext-4.9.0-00000000000eeeee";
const EXTRADEP = "extradep-1.0.0-00000000000ex001";
const RPKGA = "rpkga-1.0-000000000000fff0";
const RPKGB = "rpkgb-2.1-000000000000fff1";

const created: string[] = [];

/** A temporary directory that the sweep removes after the test. */
function tempDir(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    created.push(root);
    return root;
}

/**
 * A store root that holds the fixture pool, the graph, and a catalog template farm.
 *
 * The template is derived rather than checked in, because its links bake an absolute
 * target under the sandbox mount and such a target resolves nowhere on the host.
 */
function tempStore(): string {
    const root = tempDir("inflexa-run-farm-");
    cpSync(FIXTURE, root, { recursive: true });

    const template = join(root, "farms", "catalog");
    mkdirSync(join(template, "python", "site-packages"), { recursive: true });
    mkdirSync(join(template, "r", "cran"), { recursive: true });
    for (const [name, storeDir] of [
        ["Rpkga", RPKGA],
        ["Rpkgb", RPKGB],
    ]) {
        symlinkSync(`${MOUNT}/store/${storeDir}/${name}`, join(template, "r", "cran", name as string));
    }
    for (const cache of ["numba-cache", "matplotlib_config"]) {
        mkdirSync(join(template, cache), { recursive: true });
        writeFileSync(join(template, cache, "warm.bin"), "warm\n");
    }
    writeFileSync(
        join(template, "lock.json"),
        `${JSON.stringify({ requested: ["beta", "gamma", "typing_ext"], resolved: [], store_dirs: [ALPHA, BETA, GAMMA, DELTA, TYPING, EXTRADEP] }, null, 2)}\n`,
    );
    writeFileSync(join(template, "meta.json"), `${JSON.stringify({ version: "catalog", arch: "linux-arm64", tracks: ["python", "r"] }, null, 2)}\n`);
    return root;
}

/** A plan with one step for each entry of `packages`. The pass reads the package entries and nothing else. */
function planNaming(...packages: string[][]): AnalysisPlan {
    return AnalysisPlanSchema.parse({
        title: "The package pass",
        analytical_narrative: "Name the packages of each step.",
        created_at: "2026-08-14T00:00:00.000Z",
        steps: packages.map((entries, at) => ({
            id: `T1S${at + 1}`,
            name: `step ${at + 1}`,
            track: "T1",
            step_type: "analysis",
            question: "q",
            acceptance_criteria: ["a"],
            depends_on: at === 0 ? [] : [`T1S${at}`],
            maxSteps: 8,
            resources: { cpu: 1, memoryGb: 2 },
            packages: entries,
        })),
    });
}

/** The closure that a farm links right now, read from the lock that the composer wrote. */
function farmClosure(storeRoot: string, analysisId: string): string[] {
    // The composer wrote this file, thus `store_dirs` is a list of store-directory
    // names. The cast records that the shape comes from the writer and not from a user.
    const lock = JSON.parse(readFileSync(join(storeRoot, "farms", analysisId, "lock.json"), "utf8")) as { readonly store_dirs: string[] };
    return [...lock.store_dirs].sort();
}

beforeEach(() => {
    // The per-farm mutex writes under `env.locksDir`, thus the sandbox guard must pass
    // before any test of the package pass runs.
    assertTestSandbox(env.locksDir);
});

afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("linkPlanPackages — a package that the pool lacks", () => {
    test("asks the user to install it, and the run does not start", async () => {
        const storeRoot = tempStore();
        const analysisId = randomUUIDv7();
        (await makeEmptyFarm({ storeRoot, analysisId }))._unsafeUnwrap();
        const { seams, rec } = makeSeams();

        // `runAnalysis` applies the pass BEFORE the trigger, and it maps an Err to
        // `fail`. This is that gate, thus the recorder proves that a refused plan
        // reserves no run row and launches no workflow.
        const pass = await linkPlanPackages({ storeRoot, analysisId, plan: planNaming(["beta"], ["nosuchpkg"]) });
        if (pass.isOk()) (await triggerAnalysisRun(seams, PARAMS))._unsafeUnwrap();

        const e = pass._unsafeUnwrapErr();
        if (e.type !== "packages_unavailable") throw new Error(`expected a pool refusal, got ${e.type}`);
        expect(e.refusals).toEqual([
            { kind: "not_in_pool", requirement: "nosuchpkg", track: null, cause: { type: "unknown_distribution", requested: "nosuchpkg", name: "nosuchpkg" } },
        ]);
        const report = describePlanPackageError(e);
        expect(report).toContain("inflexa store add nosuchpkg");
        expect(report).toContain("This store acquires no R package");
        expect(rec.insertRun).toBe(0);
        expect(rec.launch).toBe(0);
        // The pool holds beta, thus the farm took it although a second requirement refused.
        expect(farmClosure(storeRoot, analysisId)).toEqual([ALPHA, BETA].sort());
    });

    test("a version of an R package carries a reason of its own", async () => {
        const storeRoot = tempStore();
        const analysisId = randomUUIDv7();
        (await makeEmptyFarm({ storeRoot, analysisId }))._unsafeUnwrap();

        const e = (await linkPlanPackages({ storeRoot, analysisId, plan: planNaming(["rpkga==9.9"]) }))._unsafeUnwrapErr();

        if (e.type !== "packages_unavailable") throw new Error(`expected a pool refusal, got ${e.type}`);
        expect(e.refusals[0]?.kind === "not_in_pool" && e.refusals[0].track).toBe("r");
        const report = describePlanPackageError(e);
        expect(report).toContain('R package "rpkga"');
        expect(report).toContain("no retry of that version succeeds");
        // No package resolved, thus the farm stays empty.
        expect(farmClosure(storeRoot, analysisId)).toEqual([]);
    });

    test("a link failure lands in the same report as the missing package", async () => {
        const storeRoot = tempStore();
        const analysisId = randomUUIDv7();
        (await makeEmptyFarm({ storeRoot, analysisId }))._unsafeUnwrap();

        // Two versions of one distribution claim the top-level name `alpha`, thus the
        // link pass refuses the whole batch and the farm stays exactly as it was.
        const e = (await linkPlanPackages({ storeRoot, analysisId, plan: planNaming(["alpha==1.2.0", "alpha==2.0.0", "nosuchpkg"]) }))._unsafeUnwrapErr();

        if (e.type !== "packages_unavailable") throw new Error(`expected a pool refusal, got ${e.type}`);
        expect(e.refusals.map((refusal) => refusal.kind)).toEqual(["not_in_pool", "link_failed"]);
        const report = describePlanPackageError(e);
        expect(report).toContain("inflexa store add nosuchpkg");
        expect(report).toContain('Two store directories claim the name "alpha"');
        expect(farmClosure(storeRoot, analysisId)).toEqual([]);
    });

    test("a store with no dependency graph refuses before it resolves anything", async () => {
        const e = (
            await linkPlanPackages({ storeRoot: tempDir("inflexa-run-nostore-"), analysisId: randomUUIDv7(), plan: planNaming(["beta"]) })
        )._unsafeUnwrapErr();

        expect(e.type).toBe("pool_unreadable");
    });
});

describe("linkPlanPackages — packages that the pool holds", () => {
    test("links each package and its closure, the farm holds nothing more, and the run starts", async () => {
        const storeRoot = tempStore();
        const analysisId = randomUUIDv7();
        (await makeEmptyFarm({ storeRoot, analysisId }))._unsafeUnwrap();
        const { seams, rec } = makeSeams();

        const link = (await linkPlanPackages({ storeRoot, analysisId, plan: planNaming(["beta"], ["gamma"]) }))._unsafeUnwrap();
        const out = (await triggerAnalysisRun(seams, PARAMS))._unsafeUnwrap();

        expect(link.requested).toEqual(["beta", "gamma"]);
        expect(link.linked.map((match) => `${match.answer.name}==${match.answer.version}`)).toEqual(["beta==0.4.1", "gamma==3.0.0"]);
        // beta reaches alpha and gamma reaches delta, thus the closure holds four
        // store directories and it holds nothing outside them.
        expect([...link.storeDirs].sort()).toEqual([ALPHA, BETA, DELTA, GAMMA].sort());
        expect(farmClosure(storeRoot, analysisId)).toEqual([ALPHA, BETA, DELTA, GAMMA].sort());
        expect(out).toEqual({ kind: "started", runId: "run-fixed" });
        expect(rec.launch).toBe(1);
    });

    test("a plan that names no package reads neither the graph nor the farm", async () => {
        const link = (await linkPlanPackages({ storeRoot: tempDir("inflexa-run-nostore-"), analysisId: randomUUIDv7(), plan: PLAN }))._unsafeUnwrap();

        expect(link).toEqual({ requested: [], linked: [], storeDirs: [] });
    });
});

describe("triggerAnalysisRun — dedup pre-check", () => {
    test("an active run for the same plan returns already_active without authorizing or launching", async () => {
        const { seams, rec } = makeSeams({ activeRuns: [runRow({ runId: "run-live", status: "running" })] });

        const out = (await triggerAnalysisRun(seams, PARAMS))._unsafeUnwrap();

        expect(out).toEqual({ kind: "already_active", runId: "run-live", status: "running" });
        expect(rec.insertRun).toBe(0);
        expect(rec.authorize).toBe(0);
        expect(rec.launch).toBe(0);
    });

    test("a dedup-read failure surfaces as dedup_failed", async () => {
        const seams: RunTriggerSeams = { ...makeSeams().seams, queryActiveRun: () => errAsync(DB_ERROR) };

        const e = (await triggerAnalysisRun(seams, PARAMS))._unsafeUnwrapErr();

        expect(e.type).toBe("dedup_failed");
    });
});

describe("triggerAnalysisRun — reservation", () => {
    test("a partial-unique collision resolves to the winner's run", async () => {
        const { seams, rec } = makeSeams({
            activeRuns: [null, runRow({ runId: "run-winner", status: "running" })],
            insertThrows: new RunDedupCollisionError("an-1", "pln-abc12345"),
        });

        const out = (await triggerAnalysisRun(seams, PARAMS))._unsafeUnwrap();

        expect(out).toEqual({ kind: "already_active", runId: "run-winner", status: "running" });
        // The loser authorized nothing and launched nothing.
        expect(rec.authorize).toBe(0);
        expect(rec.launch).toBe(0);
        // Pre-check + collision recovery = two active-run reads.
        expect(rec.queryActiveRun).toBe(2);
    });

    test("a plain reservation driver failure surfaces as reserve_failed", async () => {
        const { seams, rec } = makeSeams({ insertErr: true });

        const e = (await triggerAnalysisRun(seams, PARAMS))._unsafeUnwrapErr();

        expect(e.type).toBe("reserve_failed");
        expect(rec.authorize).toBe(0);
    });
});

describe("triggerAnalysisRun — post-reserve failures release the slot", () => {
    test("authorization failure marks the reserved row failed and does not launch", async () => {
        const { seams, rec } = makeSeams({ authorizeThrows: new Error("mint refused") });

        const e = (await triggerAnalysisRun(seams, PARAMS))._unsafeUnwrapErr();

        expect(e.type).toBe("authorize_failed");
        if (e.type === "authorize_failed") expect(e.runId).toBe("run-fixed");
        expect(rec.updateRunStatus).toEqual([{ runId: "run-fixed", status: "failed", error: "run authorization failed" }]);
        expect(rec.launch).toBe(0);
    });

    test("launch failure revokes the authorization and marks the reserved row failed", async () => {
        const { seams, rec } = makeSeams({ launchThrows: new Error("dbos down") });

        const e = (await triggerAnalysisRun(seams, PARAMS))._unsafeUnwrapErr();

        expect(e.type).toBe("launch_failed");
        if (e.type === "launch_failed") expect(e.runId).toBe("run-fixed");
        expect(rec.revoke).toBe(1);
        expect(rec.updateRunStatus).toEqual([{ runId: "run-fixed", status: "failed", error: "workflow start failed" }]);
    });
});

describe("triggerAnalysisRun — happy path", () => {
    test("launches under workflowId = runId with a correctly-shaped input", async () => {
        const { seams, rec } = makeSeams();

        const out = (await triggerAnalysisRun(seams, PARAMS))._unsafeUnwrap();

        expect(out).toEqual({ kind: "started", runId: "run-fixed" });
        expect(rec.launched?.runId).toBe("run-fixed");

        const input = rec.launched?.input;
        if (!input) throw new Error("expected the launch seam to capture the workflow input");
        expect(input.analysisId).toBe("an-1");
        expect(input.planId).toBe("pln-abc12345");
        expect(input.planSummary).toBe("Differential expression");
        expect(input.threadId).toBe(null);
        expect(input.steps).toEqual([
            { id: "T1S1", depends_on: [] },
            { id: "T1S2", depends_on: ["T1S1"] },
        ]);
        // The step DATA rides through intact, keyed by id — never a pre-rendered
        // prompt string. The harness composes each step's seed at dispatch, so it
        // needs the step's own instructions (question, acceptance criteria, deps).
        expect(Object.keys(input.planStepById)).toEqual(["T1S1", "T1S2"]);
        expect(input.planStepById["T1S1"]).toEqual(PLAN.steps[0]);
        expect(input.planStepById["T1S2"]).toEqual(PLAN.steps[1]);
        expect(input).not.toHaveProperty("promptByStepId");
        // T1S2 declares no agent → the "unknown" default.
        expect(input.agentByStepId).toEqual({ T1S1: "scientific-executor", T1S2: "unknown" });
        expect(input.resourcesByStepId).toEqual({ T1S1: { cpu: 2, memoryGb: 4 }, T1S2: { cpu: 1, memoryGb: 2 } });
        // Only the step that declared a timeout appears.
        expect(input.timeoutByStepId).toEqual({ T1S1: 120 });
        expect(input.runSession).toBe(RUN_SESSION);
        expect(input.ownsMandate).toBe(true);
    });
});
