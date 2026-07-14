import { describe, expect, test } from "bun:test";
import { okAsync, errAsync } from "neverthrow";
import {
    AnalysisPlanSchema,
    makeLocalAuth,
    RunDedupCollisionError,
    type CortexRunRow,
    type ExecuteAnalysisInput,
    type RunSession,
    type RunStatus,
} from "@inflexa-ai/harness";

import { triggerAnalysisRun, type RunTriggerSeams, type TriggerAnalysisRunParams } from "./run.ts";

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
