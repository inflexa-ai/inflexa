import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUIDv7 } from "bun";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import {
    createRunEventStream,
    UnknownRunError,
    type AgentSession,
    type ApprovePlanInput,
    type ApprovePlanRefusal,
    type CortexRunRow,
    type DataProfileStatus,
    type Pool,
    type PlanApproval,
    type PlanRecord,
    type RunArtifactCount,
    type StepExecutionRow,
} from "@inflexa-ai/harness";

import { DATA_PROFILE_RUN_LITERAL } from "@inflexa-ai/harness/contracts/index.js";

import type {
    CancelRunResult,
    ChatContext,
    DataProfileView,
    FarmHealResult,
    PlanApprovalResult,
    PlanView,
    ProfileRerunResult,
    RunDetail,
    RunList,
    RunSynthesisView,
    SandboxReadiness,
} from "../../api/runs.ts";
import type { ServerBootState } from "../../api/server.ts";
import { insertAnalysis, insertAnalysisInput, insertAnchor, upsertLlmUsage } from "../../db/primary_mutation.ts";
import { db } from "../../db/primary.ts";
import { listAnalysisPage, listSeenRunIds } from "../../db/primary_query.ts";
import { asStr256 } from "../../lib/types.ts";
import { invalidateWorkspaceRoot, workspaceRootForAnalysisId } from "../../modules/analysis/output.ts";
import { writeMarker } from "../../modules/anchor/marker.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import type { StampedEvent } from "../../types/events.ts";
import { freshDb } from "../../test_support/db.ts";
import type { ServerBoot } from "../boot.ts";
import type { ServerEnv } from "../http.ts";
import { __resetProfileQueueForTest, profileWorkInFlight, serializeProfileWork, watchInputDrift } from "../profile_queue.ts";
import { __resetTurnsForTest, refuseNewTurns, startTurn } from "../turns.ts";
import { DEFAULT_RUN_ROUTES_OPTS, runRoutes, type RunRoutesOpts } from "./runs.ts";

// The routes under the mount path of the app, with no bearer check and no analysis guard: `app.test.ts` covers
// those. Each harness read is a fake, because each needs Postgres or DBOS. Each `as` cast of a body below reads
// JSON that the route under test builds from the same `src/api/` type.

const identity = { version: "0.0.0-test", apiVersion: 1, startedAt: "2026-10-02T00:00:00.000Z" } as const;
// The routes only pass the pool to the injected reads, and the stream test passes it to the harness reader,
// whose ledger reads find no rows in this pool. Thus a stand-in object is enough.
const pool = { query: () => Promise.resolve({ rows: [], rowCount: 0 }) } as unknown as Pool;
const runtime = { pool } as unknown as HarnessRuntime;

const readyBoot: ServerBoot = {
    state: () => ({ ...identity, phase: "ready", connection: { provider: "anthropic", mode: "cliproxy", model: "m" } }),
    runtime: () => runtime,
    start: async () => undefined,
};

function failing(name: string): () => never {
    return () => {
        throw new Error(`the test did not expect a call of ${name}`);
    };
}

const UNEXPECTED: RunRoutesOpts = {
    listRuns: failing("listRuns"),
    listThreadRuns: failing("listThreadRuns"),
    listActiveRuns: failing("listActiveRuns"),
    getRun: failing("getRun"),
    countArtifacts: failing("countArtifacts"),
    readSynthesis: failing("readSynthesis"),
    listSteps: failing("listSteps"),
    loadPlan: failing("loadPlan"),
    loadPlanRecord: failing("loadPlanRecord"),
    listPlanRunIds: failing("listPlanRunIds"),
    loadProfile: failing("loadProfile"),
    subscribeRun: failing("subscribeRun"),
    cancelRun: failing("cancelRun"),
    ensureParity: failing("ensureParity"),
    forceReprofile: failing("forceReprofile"),
    readiness: failing("readiness"),
    sandboxRefusal: failing("sandboxRefusal"),
    healFarm: failing("healFarm"),
    approvePlan: failing("approvePlan"),
};

/** The routes over a sandbox that can start, unless `opts` gives a refusal. */
function appWith(opts: Partial<RunRoutesOpts>, boot: ServerBoot = readyBoot): Hono<ServerEnv> {
    return new Hono<ServerEnv>().route(
        "/api/v1/analyses/:analysisId",
        runRoutes(boot, { ...UNEXPECTED, sandboxRefusal: () => Promise.resolve(null), countArtifacts: () => okAsync([]), ...opts }),
    );
}

const IMAGE_REFUSAL = "The sandbox image is not installed. Run `inflexa sandbox pull` to download it.";

/** A run of the ledger, with the fields that the routes read. */
function runRow(overrides: Partial<CortexRunRow> & Pick<CortexRunRow, "runId" | "analysisId">): CortexRunRow {
    return {
        threadId: null,
        workflowName: "executeAnalysis",
        status: "completed",
        startedAt: "2026-10-01T10:00:00.000Z",
        completedAt: "2026-10-01T10:05:00.000Z",
        error: null,
        synthesisStatus: null,
        synthesisReason: null,
        parts: null,
        mandateJti: null,
        mandateExpiresAt: null,
        planId: null,
        ...overrides,
    };
}

function stepRow(overrides: Partial<StepExecutionRow> & Pick<StepExecutionRow, "runId" | "stepId">): StepExecutionRow {
    return {
        analysisId: "a",
        wave: 0,
        agentId: "bio",
        status: "completed",
        startedAt: "2026-10-01T10:01:00.000Z",
        completedAt: "2026-10-01T10:02:00.000Z",
        durationMs: 60_000,
        error: null,
        attempts: 1,
        lastErrorClass: null,
        finishReason: null,
        hitMaxSteps: false,
        blockedReason: null,
        sandboxRef: null,
        childWorkflowId: null,
        ...overrides,
    };
}

/** A stored plan document that the harness plan schema accepts. `steps` is `[id, dependsOn]` for each step. */
function planDocument(steps: ReadonlyArray<readonly [string, readonly string[]]>, title = "Liver DE"): unknown {
    return {
        title,
        analytical_narrative: "why",
        created_at: "2026-10-01T00:00:00.000Z",
        steps: steps.map(([id, dependsOn]) => ({
            id,
            name: `Name of ${id}`,
            track: "1",
            step_type: "analysis",
            question: "Which genes change?",
            acceptance_criteria: [],
            depends_on: dependsOn,
            maxSteps: 10,
            agent: "rna-seq",
        })),
    };
}

function planRecord(overrides: Partial<PlanRecord> = {}): PlanRecord {
    return {
        planId: "pln-0000000a",
        plan: planDocument([["T1S1", []]]),
        parentPlanId: null,
        supersededBy: null,
        createdAt: "2026-10-01T00:00:00.000Z",
        ...overrides,
    };
}

function profileRow(overrides: Partial<DataProfileStatus> = {}): DataProfileStatus {
    return { status: "completed", error: null, startedAt: null, completedAt: null, result: null, workflowId: null, seedInputFileIds: null, ...overrides };
}

/** A new analysis row in the test database. */
function seedAnalysis(): string {
    const now = Date.now();
    const anchorId = randomUUIDv7();
    insertAnchor({ id: anchorId, createdAt: now, updatedAt: now, cachedPath: `/tmp/${anchorId}`, markerWritten: false, lastSeen: now })._unsafeUnwrap();
    const id = randomUUIDv7();
    insertAnalysis({ id, createdAt: now, updatedAt: now, name: asStr256("liver"), slug: `liver-${id}`, anchorId, projectId: null })._unsafeUnwrap();
    return id;
}

/** One call of the local ledger, under the run (and step) that `where` names. */
function seedUsage(analysisId: string, where: { runId: string; stepId?: string }, inputTokens: number): void {
    upsertLlmUsage({
        recordKey: randomUUIDv7(),
        recordedAt: Date.now(),
        agentId: "bio",
        callPath: "bio",
        scopeKind: "analysis",
        scopeId: analysisId,
        runId: where.runId,
        ...(where.stepId === undefined ? {} : { stepId: where.stepId }),
        usage: { inputTokens },
    })._unsafeUnwrap();
}

/** The `data:` frames of a finished SSE body. */
async function sseFrames(response: Response): Promise<unknown[]> {
    const text = await response.text();
    return text
        .split("\n\n")
        .filter((block) => block.startsWith("data: "))
        .map((block): unknown => JSON.parse(block.slice("data: ".length)));
}

beforeEach(() => {
    freshDb();
    __resetProfileQueueForTest();
});

describe("GET {A}/runs", () => {
    test("each run carries its plan title and its usage; each distinct plan loads one time", async () => {
        const analysisId = seedAnalysis();
        const rows = [
            runRow({ runId: "r1", analysisId, planId: "p1", status: "running", completedAt: null }),
            runRow({ runId: "r2", analysisId, planId: "p1" }),
            runRow({ runId: "r3", analysisId }),
        ];
        const planLoads: string[] = [];
        seedUsage(analysisId, { runId: "r1" }, 10);
        seedUsage(analysisId, { runId: "r1", stepId: "s1" }, 5);

        const app = appWith({
            listRuns: (_pool, id, page) => okAsync({ rows: id === analysisId ? rows.slice(page.offset, page.offset + page.limit) : [], total: 3 }),
            loadPlan: (_pool, planId) => {
                planLoads.push(planId);
                return okAsync({ title: "  Liver DE  " });
            },
        });
        const list = (await (await app.request(`/api/v1/analyses/${analysisId}/runs`)).json()) as RunList;

        expect(planLoads).toEqual(["p1"]);
        expect(list).toMatchObject({ total: 3, page: 0, perPage: 100, hasMore: false });
        expect(list.runs.map((run) => [run.runId, run.planTitle, run.usage])).toEqual([
            ["r1", "Liver DE", { calls: 2, inputTokens: 15 }],
            ["r2", "Liver DE", undefined],
            ["r3", undefined, undefined],
        ]);
        expect(list.runs[0]).toMatchObject({ workflowId: "r1", status: "running", completedAt: null, threadId: null });
    });

    test("each run carries its plan id, or null, and the list reads no plan record and no run ids", async () => {
        const analysisId = seedAnalysis();
        const rows = [runRow({ runId: "r1", analysisId, planId: "p1" }), runRow({ runId: "r2", analysisId })];
        const app = appWith({ listRuns: () => okAsync({ rows, total: 2 }), loadPlan: () => okAsync(null) });
        const list = (await (await app.request(`/api/v1/analyses/${analysisId}/runs`)).json()) as RunList;

        expect(list.runs.map((run) => [run.runId, run.planId])).toEqual([
            ["r1", "p1"],
            ["r2", null],
        ]);
    });

    test("each run carries the artifact count of one grouped read, and a run with no entry gets 0", async () => {
        const analysisId = seedAnalysis();
        const reads: string[][] = [];
        const app = appWith({
            listRuns: () => okAsync({ rows: [runRow({ runId: "r1", analysisId }), runRow({ runId: "r2", analysisId })], total: 2 }),
            countArtifacts: (_pool, id, runIds) => {
                reads.push([id, ...runIds]);
                return okAsync([{ runId: "r1", count: 3 }]);
            },
        });
        const list = (await (await app.request(`/api/v1/analyses/${analysisId}/runs`)).json()) as RunList;

        expect(list.runs.map((run) => [run.runId, run.artifactCount])).toEqual([
            ["r1", 3],
            ["r2", 0],
        ]);
        expect(reads).toEqual([[analysisId, "r1", "r2"]]);
    });

    test.each([1, 200])("a page of %i runs sends one count read", async (perPage) => {
        const analysisId = seedAnalysis();
        const rows = Array.from({ length: perPage }, (_, index) => runRow({ runId: `r${index}`, analysisId }));
        let reads = 0;
        const app = appWith({
            listRuns: (_pool, _id, page) => okAsync({ rows: rows.slice(0, page.limit), total: perPage }),
            countArtifacts: () => {
                reads += 1;
                return okAsync<RunArtifactCount[], never>([]);
            },
        });
        const list = (await (await app.request(`/api/v1/analyses/${analysisId}/runs?perPage=${perPage}`)).json()) as RunList;

        expect(list.runs).toHaveLength(perPage);
        expect(reads).toBe(1);
    });

    test("a failed count read costs the count, never the response", async () => {
        const analysisId = seedAnalysis();
        const app = appWith({
            listRuns: () => okAsync({ rows: [runRow({ runId: "r1", analysisId })], total: 1 }),
            countArtifacts: () => errAsync({ type: "query_failed", op: "test", cause: "down" }),
        });
        const response = await app.request(`/api/v1/analyses/${analysisId}/runs`);
        const list = (await response.json()) as RunList;

        expect(response.status).toBe(200);
        expect(list.runs).toHaveLength(1);
        expect(list.runs[0]).not.toHaveProperty("artifactCount");
    });

    test("a plan that cannot be read costs its title, never the row", async () => {
        const analysisId = seedAnalysis();
        const app = appWith({
            listRuns: () => okAsync({ rows: [runRow({ runId: "r1", analysisId, planId: "p1" })], total: 1 }),
            loadPlan: () => errAsync({ type: "query_failed", cause: new Error("down") } as never),
        });
        const list = (await (await app.request(`/api/v1/analyses/${analysisId}/runs`)).json()) as RunList;
        expect(list.runs.map((run) => run.runId)).toEqual(["r1"]);
        expect(list.runs[0]?.planTitle).toBeUndefined();
    });

    test("`active=true` pages the runs that are not terminal", async () => {
        const analysisId = seedAnalysis();
        const active = [runRow({ runId: "a1", analysisId, status: "running" }), runRow({ runId: "a2", analysisId, status: "running" })];
        const app = appWith({ listActiveRuns: () => okAsync(active), loadPlan: () => okAsync(null) });
        const list = (await (await app.request(`/api/v1/analyses/${analysisId}/runs?active=true&perPage=1&page=1`)).json()) as RunList;
        expect(list.runs.map((run) => run.runId)).toEqual(["a2"]);
        expect(list).toMatchObject({ total: 2, page: 1, perPage: 1, hasMore: false });
    });

    test("`threadId` reads one row past the page to tell that a later page has runs", async () => {
        const analysisId = seedAnalysis();
        const threadRuns = ["t1", "t2", "t3"].map((runId) => runRow({ runId, analysisId, threadId: "th" }));
        const reads: { threadId: string; limit: number; offset: number }[] = [];
        const app = appWith({
            listThreadRuns: (_pool, _id, threadId, page) => {
                reads.push({ threadId, ...page });
                return okAsync(threadRuns.slice(page.offset, page.offset + page.limit));
            },
        });
        const first = (await (await app.request(`/api/v1/analyses/${analysisId}/runs?threadId=th&perPage=2`)).json()) as RunList;
        expect(reads).toEqual([{ threadId: "th", limit: 3, offset: 0 }]);
        expect(first.runs.map((run) => run.runId)).toEqual(["t1", "t2"]);
        expect(first.hasMore).toBe(true);

        const last = (await (await app.request(`/api/v1/analyses/${analysisId}/runs?threadId=th&perPage=2&page=1`)).json()) as RunList;
        expect(last.runs.map((run) => run.runId)).toEqual(["t3"]);
        expect(last).toMatchObject({ total: 3, hasMore: false });
    });

    test("500 `internal_error` when the ledger read fails", async () => {
        const app = appWith({ listRuns: () => errAsync({ type: "query_failed", cause: new Error("down") } as never) });
        const response = await app.request("/api/v1/analyses/x/runs");
        expect(response.status).toBe(500);
        expect(await response.json()).toMatchObject({ error: "internal_error" });
    });

    test("503 `unavailable` while the runtime boots", async () => {
        const starting: ServerBootState = { ...identity, phase: "starting", boot: { attemptStartedAt: identity.startedAt, step: null, done: [] } };
        const app = appWith({}, { state: () => starting, runtime: () => null, start: async () => undefined });
        const response = await app.request("/api/v1/analyses/x/runs");
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ error: "unavailable", details: { phase: "starting" } });
    });
});

describe("GET {A}/run/:runId", () => {
    test("the run with its steps, the plan names of the steps, and the usage of each step", async () => {
        const analysisId = seedAnalysis();
        seedUsage(analysisId, { runId: "r1", stepId: "T1S1" }, 7);
        seedUsage(analysisId, { runId: "r1" }, 3);
        const app = appWith({
            getRun: () => okAsync(runRow({ runId: "r1", analysisId, planId: "p1" })),
            listSteps: () =>
                okAsync([stepRow({ runId: "r1", stepId: "T1S1" }), stepRow({ runId: "r1", stepId: "T1S2", status: "blocked", blockedReason: "no data" })]),
            loadPlan: () => okAsync({ title: "Plan", steps: [{ id: "T1S1", name: "Align reads" }, { id: "T1S2" }] }),
        });
        const detail = (await (await app.request(`/api/v1/analyses/${analysisId}/run/r1`)).json()) as RunDetail;

        expect(detail).toMatchObject({ runId: "r1", planTitle: "Plan", usage: { calls: 2, inputTokens: 10 }, unattributedUsage: { calls: 1, inputTokens: 3 } });
        expect(detail.steps).toEqual([
            expect.objectContaining({ stepId: "T1S1", name: "Align reads", status: "completed", usage: { calls: 1, inputTokens: 7 } }),
            expect.objectContaining({ stepId: "T1S2", status: "blocked", blockedReason: "no data" }),
        ]);
        expect(detail.steps[1]).not.toHaveProperty("name");
        expect(detail.steps[1]).not.toHaveProperty("usage");
    });

    test("the run carries its artifact count, from a read of the one run", async () => {
        const analysisId = seedAnalysis();
        const reads: string[][] = [];
        const app = appWith({
            getRun: () => okAsync(runRow({ runId: "r1", analysisId })),
            listSteps: () => okAsync([]),
            countArtifacts: (_pool, _id, runIds) => {
                reads.push([...runIds]);
                return okAsync([{ runId: "r1", count: 4 }]);
            },
        });
        const detail = (await (await app.request(`/api/v1/analyses/${analysisId}/run/r1`)).json()) as RunDetail;

        expect(detail.artifactCount).toBe(4);
        expect(reads).toEqual([["r1"]]);
    });

    describe("the plan graph", () => {
        function detailApp(analysisId: string, plan: () => ReturnType<RunRoutesOpts["loadPlan"]>, planLoads: string[] = []): Hono<ServerEnv> {
            return appWith({
                getRun: () => okAsync(runRow({ runId: "r1", analysisId, planId: "p1" })),
                listSteps: () => okAsync([stepRow({ runId: "r1", stepId: "T1S1" }), stepRow({ runId: "r1", stepId: "T1S2" })]),
                loadPlan: (_pool, planId) => {
                    planLoads.push(planId);
                    return plan();
                },
            });
        }

        test("gives each plan step with its agent, its dependencies, and its level, and a step that did not start", async () => {
            const analysisId = seedAnalysis();
            const planLoads: string[] = [];
            const document = planDocument([
                ["T1S1", []],
                ["T1S2", ["T1S1"]],
                ["T1S3", ["T1S2"]],
            ]);
            const app = detailApp(analysisId, () => okAsync(document), planLoads);
            const detail = (await (await app.request(`/api/v1/analyses/${analysisId}/run/r1`)).json()) as RunDetail;

            expect(detail.planId).toBe("p1");
            expect(detail.plan).toEqual({
                planId: "p1",
                steps: [
                    { id: "T1S1", name: "Name of T1S1", agent: "rna-seq", dependsOn: [], level: 0 },
                    { id: "T1S2", name: "Name of T1S2", agent: "rna-seq", dependsOn: ["T1S1"], level: 1 },
                    { id: "T1S3", name: "Name of T1S3", agent: "rna-seq", dependsOn: ["T1S2"], level: 2 },
                ],
            });
            expect(detail.steps.map((step) => step.stepId)).toEqual(["T1S1", "T1S2"]);
            expect(planLoads).toEqual(["p1"]);
        });

        test("is null for a run with no plan, and the plan is not read", async () => {
            const analysisId = seedAnalysis();
            const planLoads: string[] = [];
            const app = appWith({
                getRun: () => okAsync(runRow({ runId: "r1", analysisId })),
                listSteps: () => okAsync([]),
                loadPlan: (_pool, planId) => {
                    planLoads.push(planId);
                    return okAsync(null);
                },
            });
            const detail = (await (await app.request(`/api/v1/analyses/${analysisId}/run/r1`)).json()) as RunDetail;

            expect(detail.planId).toBeNull();
            expect(detail.plan).toBeNull();
            expect(planLoads).toEqual([]);
        });

        test("is null with a 200 when the plan is gone", async () => {
            const analysisId = seedAnalysis();
            const response = await detailApp(analysisId, () => okAsync(null)).request(`/api/v1/analyses/${analysisId}/run/r1`);

            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({ planId: "p1", plan: null });
        });

        test("is null with a 200 when the plan read fails", async () => {
            const analysisId = seedAnalysis();
            const response = await detailApp(analysisId, () => errAsync({ type: "query_failed", cause: new Error("down") } as never)).request(
                `/api/v1/analyses/${analysisId}/run/r1`,
            );

            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({ planId: "p1", plan: null });
        });

        test("is null for a plan with a cycle, and for a document that is not a plan", async () => {
            const analysisId = seedAnalysis();
            const cycle = planDocument([
                ["T1S1", ["T1S2"]],
                ["T1S2", ["T1S1"]],
            ]);
            for (const document of [cycle, { title: "no steps" }]) {
                const detail = (await (
                    await detailApp(analysisId, () => okAsync(document)).request(`/api/v1/analyses/${analysisId}/run/r1`)
                ).json()) as RunDetail;
                expect(detail.plan).toBeNull();
            }
        });
    });

    test("404 `not_found` for a run of a different analysis, and for an unknown run", async () => {
        const foreign = appWith({ getRun: () => okAsync(runRow({ runId: "r1", analysisId: "other" })) });
        const response = await foreign.request("/api/v1/analyses/mine/run/r1");
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "not_found", message: "This analysis has no run r1." });

        const unknown = appWith({ getRun: () => okAsync(null) });
        expect((await unknown.request("/api/v1/analyses/mine/run/r1")).status).toBe(404);
    });
});

describe("GET {A}/plans/:planId", () => {
    type Reads = { record: Array<[string, string]>; runIds: Array<[string, string, number]> };

    function planApp(record: PlanRecord | null, runIds: string[], boot: ServerBoot = readyBoot): { app: Hono<ServerEnv>; reads: Reads } {
        const reads: Reads = { record: [], runIds: [] };
        const app = appWith(
            {
                loadPlanRecord: (_pool, planId, analysisId) => {
                    reads.record.push([planId, analysisId]);
                    return okAsync(record);
                },
                listPlanRunIds: (_pool, analysisId, planId, limit) => {
                    reads.runIds.push([analysisId, planId, limit]);
                    return okAsync(runIds.slice(0, limit));
                },
            },
            boot,
        );
        return { app, reads };
    }

    async function planOf(app: Hono<ServerEnv>, planId = "pln-0000000a"): Promise<PlanView> {
        return (await (await app.request(`/api/v1/analyses/a1/plans/${planId}`)).json()) as PlanView;
    }

    test("a revised plan names the newer plan, with the card and the runs, in two reads", async () => {
        const { app, reads } = planApp(planRecord({ supersededBy: "pln-0000000b" }), ["r2", "r1"]);
        const view = await planOf(app);

        expect(view).toMatchObject({ parentPlanId: null, supersededBy: "pln-0000000b", runIds: ["r2", "r1"], hasMoreRuns: false });
        expect(view.plan).toMatchObject({ type: "data-plan", planId: "pln-0000000a", title: "Liver DE" });
        expect(view.plan).not.toHaveProperty("parentPlanId");
        expect(reads.record).toEqual([["pln-0000000a", "a1"]]);
        expect(reads.runIds).toEqual([["a1", "pln-0000000a", 101]]);
    });

    test("a revision names its parent at the top level and in the part", async () => {
        const { app } = planApp(planRecord({ planId: "pln-0000000b", parentPlanId: "pln-0000000a" }), []);
        const view = await planOf(app, "pln-0000000b");

        expect(view.parentPlanId).toBe("pln-0000000a");
        expect(view.plan?.parentPlanId).toBe("pln-0000000a");
        expect(view).toMatchObject({ supersededBy: null, runIds: [], hasMoreRuns: false });
    });

    test("100 runs give no more, and 101 runs give the newest 100 and a flag", async () => {
        const ids = Array.from({ length: 101 }, (_, i) => `r${i}`);

        const exact = await planOf(planApp(planRecord(), ids.slice(0, 100)).app);
        expect(exact.runIds).toHaveLength(100);
        expect(exact.hasMoreRuns).toBe(false);

        const over = await planOf(planApp(planRecord(), ids).app);
        expect(over.runIds).toEqual(ids.slice(0, 100));
        expect(over.hasMoreRuns).toBe(true);
    });

    test("a plan whose document does not parse gives 200 with its lineage and its runs, and no part", async () => {
        const { app } = planApp(planRecord({ plan: { steps: "no" }, parentPlanId: "pln-0000000z", supersededBy: "pln-0000000b" }), ["r1"]);
        const response = await app.request("/api/v1/analyses/a1/plans/pln-0000000a");

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ plan: null, parentPlanId: "pln-0000000z", supersededBy: "pln-0000000b", runIds: ["r1"], hasMoreRuns: false });
    });

    test("404 `not_found` for an unknown plan and for a plan of a different analysis", async () => {
        const { app } = planApp(null, []);
        const response = await app.request("/api/v1/analyses/a1/plans/pln-0000000a");

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "not_found", message: "This analysis has no plan pln-0000000a." });
    });

    test("500 `internal_error` when either read fails", async () => {
        const down = errAsync({ type: "query_failed", cause: new Error("down") } as never);
        const recordFails = appWith({ loadPlanRecord: () => down, listPlanRunIds: () => okAsync([]) });
        const runsFail = appWith({ loadPlanRecord: () => okAsync(planRecord()), listPlanRunIds: () => down });

        for (const app of [recordFails, runsFail]) {
            const response = await app.request("/api/v1/analyses/a1/plans/pln-0000000a");
            expect(response.status).toBe(500);
            expect(await response.json()).toMatchObject({ error: "internal_error" });
        }
    });

    test("503 `unavailable` while the runtime boots, with no read", async () => {
        const starting: ServerBootState = { ...identity, phase: "starting", boot: { attemptStartedAt: identity.startedAt, step: null, done: [] } };
        const { app, reads } = planApp(planRecord(), [], { state: () => starting, runtime: () => null, start: async () => undefined });
        const response = await app.request("/api/v1/analyses/a1/plans/pln-0000000a");

        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ error: "unavailable", details: { phase: "starting" } });
        expect(reads).toEqual({ record: [], runIds: [] });
    });
});

describe("GET {A}/run/:runId/synthesis", () => {
    const part = {
        type: "data-run-synthesis" as const,
        id: "synthesis-r1",
        runId: "r1",
        overview: "ov",
        findings: [
            {
                stepId: "A",
                title: "Upregulation of FOXP3",
                description: "FOXP3 is upregulated.",
                confidence: "high" as const,
                noveltyStatus: "confirmed" as const,
                literatureInterpretation: "Consistent with prior reports.",
                references: [{ pmid: "12345678", citation: "Smith 2020", relevance: "directly supports", concordance: "supports" as const }],
            },
        ],
        themes: [],
        keyReferences: [],
    };

    test("a produced synthesis gives the status and the part with the references", async () => {
        const analysisId = seedAnalysis();
        const reads: string[][] = [];
        const app = appWith({
            getRun: () => okAsync(runRow({ runId: "r1", analysisId, synthesisStatus: "produced" })),
            readSynthesis: (id, runId) => {
                reads.push([id, runId]);
                return Promise.resolve(part);
            },
        });
        const response = await app.request(`/api/v1/analyses/${analysisId}/run/r1/synthesis`);
        const view = (await response.json()) as RunSynthesisView;

        expect(response.status).toBe(200);
        expect(view).toEqual({ status: "produced", reason: null, synthesis: part });
        expect(view.synthesis?.findings[0]?.references).toHaveLength(1);
        expect(reads).toEqual([[analysisId, "r1"]]);
    });

    test.each([
        ["skipped_blocker", "the data is not there"],
        ["skipped_no_summaries", "no step summaries"],
        ["failed", "the model refused"],
        [null, null],
    ] as const)("the outcome %s gives its reason and no part, and no record is read", async (status, reason) => {
        const analysisId = seedAnalysis();
        const app = appWith({
            getRun: () => okAsync(runRow({ runId: "r1", analysisId, synthesisStatus: status, synthesisReason: reason })),
            readSynthesis: failing("readSynthesis"),
        });
        const response = await app.request(`/api/v1/analyses/${analysisId}/run/r1/synthesis`);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ status, reason, synthesis: null });
    });

    test("a produced outcome whose record is gone gives 200 with a null synthesis", async () => {
        const analysisId = seedAnalysis();
        const app = appWith({
            getRun: () => okAsync(runRow({ runId: "r1", analysisId, synthesisStatus: "produced" })),
            readSynthesis: () => Promise.resolve(null),
        });
        const response = await app.request(`/api/v1/analyses/${analysisId}/run/r1/synthesis`);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ status: "produced", reason: null, synthesis: null });
    });

    test("404 `not_found` for a run of a different analysis, and for an unknown run", async () => {
        const foreign = appWith({ getRun: () => okAsync(runRow({ runId: "r1", analysisId: "a2" })) });
        const response = await foreign.request("/api/v1/analyses/a1/run/r1/synthesis");
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "not_found", message: "This analysis has no run r1." });

        const unknown = appWith({ getRun: () => okAsync(null) });
        expect((await unknown.request("/api/v1/analyses/a1/run/r1/synthesis")).status).toBe(404);
    });

    test("500 `internal_error` when the run row cannot be read", async () => {
        const app = appWith({ getRun: () => errAsync({ type: "query_failed", op: "test", cause: "down" }) });
        const response = await app.request("/api/v1/analyses/a1/run/r1/synthesis");
        expect(response.status).toBe(500);
        expect(await response.json()).toMatchObject({ error: "internal_error" });
    });

    test("503 `unavailable` while the runtime boots", async () => {
        const starting: ServerBootState = { ...identity, phase: "starting", boot: { attemptStartedAt: identity.startedAt, step: null, done: [] } };
        const app = appWith({}, { state: () => starting, runtime: () => null, start: async () => undefined });
        const response = await app.request("/api/v1/analyses/x/run/r1/synthesis");
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ error: "unavailable", details: { phase: "starting" } });
    });

    describe("the default record read", () => {
        const homes: string[] = [];

        afterEach(() => {
            for (const home of homes) {
                chmodSync(home, 0o755);
                rmSync(home, { recursive: true, force: true });
            }
            homes.length = 0;
            invalidateWorkspaceRoot();
        });

        /** An analysis with a marker in a new folder, and a record under its workspace root. Returns the folder. */
        async function seedWithRecord(analysisId: string): Promise<string> {
            const home = mkdtempSync(join(tmpdir(), "inflexa-synthesis-route-"));
            homes.push(home);
            (await writeMarker(home, "A1"))._unsafeUnwrap();
            insertAnchor({ id: "A1", createdAt: 1, updatedAt: 1, cachedPath: home, markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
            insertAnalysis({ id: analysisId, createdAt: 1, updatedAt: 1, name: asStr256("A"), slug: "a", anchorId: "A1", projectId: null })._unsafeUnwrap();
            // The memo is process state: a test file that ran before this one can hold a root of the same id for a deleted folder.
            invalidateWorkspaceRoot();
            const root = (await workspaceRootForAnalysisId(analysisId))._unsafeUnwrap();
            mkdirSync(join(root, "runs", "r1"), { recursive: true });
            const { type: _type, id: _id, ...stored } = part;
            writeFileSync(join(root, "runs", "r1", "synthesis.json"), JSON.stringify({ ...stored, conclusions: "cl", limitations: [] }));
            invalidateWorkspaceRoot();
            return home;
        }

        test("reads the record of the workspace folder", async () => {
            await seedWithRecord("ana-1");

            const read = await DEFAULT_RUN_ROUTES_OPTS.readSynthesis("ana-1", "r1");

            expect(read).toMatchObject({ type: "data-run-synthesis", id: "synthesis-r1", runId: "r1", conclusions: "cl" });
            expect(read?.findings[0]?.references).toEqual(part.findings[0]?.references);
        });

        test.skipIf(process.getuid?.() === 0)("reads the record of a folder that is readable but not writable", async () => {
            const home = await seedWithRecord("ana-2");
            chmodSync(home, 0o555);
            // The premise: the write-oriented locator refuses this folder.
            expect((await workspaceRootForAnalysisId("ana-2")).isErr()).toBe(true);
            invalidateWorkspaceRoot();

            const read = await DEFAULT_RUN_ROUTES_OPTS.readSynthesis("ana-2", "r1");

            expect(read).toMatchObject({ id: "synthesis-r1" });
        });

        test("gives null for an analysis with no row, and for a folder with no workspace", async () => {
            expect(await DEFAULT_RUN_ROUTES_OPTS.readSynthesis("no-such-analysis", "r1")).toBeNull();

            const home = mkdtempSync(join(tmpdir(), "inflexa-synthesis-route-"));
            homes.push(home);
            (await writeMarker(home, "A2"))._unsafeUnwrap();
            insertAnchor({ id: "A2", createdAt: 1, updatedAt: 1, cachedPath: home, markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
            insertAnalysis({ id: "ana-3", createdAt: 1, updatedAt: 1, name: asStr256("B"), slug: "b", anchorId: "A2", projectId: null })._unsafeUnwrap();
            expect(await DEFAULT_RUN_ROUTES_OPTS.readSynthesis("ana-3", "r1")).toBeNull();
        });
    });
});

describe("GET {A}/run/:runId/stream", () => {
    test("a canceled run ends with the `data-run-failed` part of reason `canceled`, then the stream closes", async () => {
        const analysisId = seedAnalysis();
        const app = appWith({
            getRun: () => okAsync(runRow({ runId: "r1", analysisId, status: "canceled" })),
            // The harness reader itself. With no DBOS in this process its stream read fails and is contained,
            // thus the parent stream drains with no terminal part, and the row read decides the end.
            subscribeRun: (p, options) =>
                createRunEventStream({ pool: p, readRun: () => okAsync({ status: "canceled", error: null }), sleep: async () => undefined }).subscribe(options),
        });
        const response = await app.request(`/api/v1/analyses/${analysisId}/run/r1/stream`);
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toBe("text/event-stream");
        expect(await sseFrames(response)).toEqual([{ type: "data-run-failed", runId: "r1", error: "Run canceled", reason: "canceled" }]);
    });

    test("the parts of the run go out as frames, in order", async () => {
        const analysisId = seedAnalysis();
        const parts = [
            { type: "data-step-activity", id: "a", runId: "r1", stepId: "s1", phase: "executing", activity: "Running deseq2.R" },
            { type: "data-run-completed", runId: "r1" },
        ];
        const app = appWith({
            getRun: () => okAsync(runRow({ runId: "r1", analysisId })),
            subscribeRun: async (_pool, options) => {
                for (const part of parts) await options.onPart(part as never);
            },
        });
        expect(await sseFrames(await app.request(`/api/v1/analyses/${analysisId}/run/r1/stream`))).toEqual(parts);
    });

    test("the workflow id of the data profile of the analysis is a stream of the analysis", async () => {
        const subscribed: string[] = [];
        const app = appWith({
            getRun: () => okAsync(null),
            loadProfile: (_pool, analysisId) => okAsync(analysisId === "mine" ? profileRow({ status: "running", workflowId: "wf-profile" }) : null),
            subscribeRun: async (_pool, options) => {
                subscribed.push(options.runId);
            },
        });
        expect((await app.request("/api/v1/analyses/mine/run/wf-profile/stream")).status).toBe(200);
        expect(subscribed).toEqual(["wf-profile"]);
        expect((await app.request("/api/v1/analyses/other/run/wf-profile/stream")).status).toBe(404);
    });

    test("404 `not_found` for a run of a different analysis, with no subscription", async () => {
        const app = appWith({ getRun: () => okAsync(runRow({ runId: "r1", analysisId: "other" })) });
        const response = await app.request("/api/v1/analyses/mine/run/r1/stream");
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ error: "not_found" });
    });
});

describe("POST {A}/run/:runId/seen", () => {
    function activityOf(analysisId: string): number | undefined {
        const page = listAnalysisPage({ projectId: null, sort: "created", limit: 100, offset: 0 })._unsafeUnwrap();
        return page.items.find((item) => item.analysis.id === analysisId)?.lastActivityAt;
    }

    function seenAtOf(runId: string): number | undefined {
        return db()._unsafeUnwrap().query<{ seen_at: number }, [string]>("SELECT seen_at FROM run_seen_marks WHERE run_id = ?").get(runId)?.seen_at;
    }

    test("a terminal run gives 200 and a mark, and a second mark gives 200 with the first time kept", async () => {
        const analysisId = seedAnalysis();
        const activityBefore = activityOf(analysisId);
        const app = appWith({ getRun: () => okAsync(runRow({ runId: "r1", analysisId, status: "failed" })) });

        const first = await app.request(`/api/v1/analyses/${analysisId}/run/r1/seen`, { method: "POST" });
        expect(first.status).toBe(200);
        expect(await first.json()).toEqual({ seen: true });
        const seenAt = seenAtOf("r1");

        const second = await app.request(`/api/v1/analyses/${analysisId}/run/r1/seen`, { method: "POST" });
        expect(second.status).toBe(200);
        expect(await second.json()).toEqual({ seen: true });
        expect(listSeenRunIds(["r1"])._unsafeUnwrap()).toEqual(new Set(["r1"]));
        expect(seenAtOf("r1")).toBe(seenAt);
        expect(activityOf(analysisId)).toBe(activityBefore);
    });

    test("each terminal status gives 200", async () => {
        const analysisId = seedAnalysis();
        for (const status of ["completed", "partial", "failed", "canceled", "suspended_insufficient_funds"] as const) {
            const app = appWith({ getRun: () => okAsync(runRow({ runId: `r-${status}`, analysisId, status })) });
            expect((await app.request(`/api/v1/analyses/${analysisId}/run/r-${status}/seen`, { method: "POST" })).status).toBe(200);
        }
        const ids = ["r-canceled", "r-completed", "r-failed", "r-partial", "r-suspended_insufficient_funds"];
        expect(listSeenRunIds(ids)._unsafeUnwrap()).toEqual(new Set(ids));
    });

    test("a run that is not terminal gives 409 `conflict` and no mark", async () => {
        const analysisId = seedAnalysis();
        const app = appWith({ getRun: () => okAsync(runRow({ runId: "r1", analysisId, status: "running", completedAt: null })) });
        const response = await app.request(`/api/v1/analyses/${analysisId}/run/r1/seen`, { method: "POST" });
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: "conflict", message: "The run has not ended." });
        expect(listSeenRunIds(["r1"])._unsafeUnwrap()).toEqual(new Set());
    });

    test("a run of a different analysis and an unknown run give 404 `not_found` and no mark", async () => {
        const analysisId = seedAnalysis();
        const other = appWith({ getRun: () => okAsync(runRow({ runId: "r1", analysisId: "elsewhere" })) });
        const foreign = await other.request(`/api/v1/analyses/${analysisId}/run/r1/seen`, { method: "POST" });
        expect(foreign.status).toBe(404);
        expect(await foreign.json()).toMatchObject({ error: "not_found" });

        const unknown = appWith({ getRun: () => okAsync(null) });
        const missing = await unknown.request(`/api/v1/analyses/${analysisId}/run/gone/seen`, { method: "POST" });
        expect(missing.status).toBe(404);
        expect(await missing.json()).toMatchObject({ error: "not_found" });
        expect(listSeenRunIds(["r1", "gone"])._unsafeUnwrap()).toEqual(new Set());
    });

    test("a failed ledger read gives 500 `internal_error`", async () => {
        const app = appWith({ getRun: () => errAsync({ type: "query_failed", op: "test", cause: "down" }) });
        const response = await app.request("/api/v1/analyses/a/run/r1/seen", { method: "POST" });
        expect(response.status).toBe(500);
        expect(await response.json()).toMatchObject({ error: "internal_error" });
    });

    test("the route waits for the runtime: 503 `unavailable` while the server boots", async () => {
        const starting: ServerBootState = { ...identity, phase: "starting", boot: { attemptStartedAt: identity.startedAt, step: null, done: [] } };
        const response = await appWith({}, { state: () => starting, runtime: () => null, start: async () => undefined }).request(
            "/api/v1/analyses/a/run/r1/seen",
            {
                method: "POST",
            },
        );
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ error: "unavailable" });
    });
});

describe("POST {A}/run/:runId/cancel", () => {
    const result: CancelRunResult = {
        runId: "r1",
        workflowId: "r1",
        outcome: "canceled",
        finalStatus: "canceled",
        converged: { steps: true, charge: true, mandate: true },
    };

    test("cancels with the local session of the analysis, and gives the result", async () => {
        const sessions: AgentSession[] = [];
        const app = appWith({
            getRun: () => okAsync(runRow({ runId: "r1", analysisId: "mine", status: "running" })),
            cancelRun: (_pool, _runId, session) => {
                sessions.push(session);
                return Promise.resolve(result);
            },
        });
        const response = await app.request("/api/v1/analyses/mine/run/r1/cancel", { method: "POST" });
        expect(response.status).toBe(200);
        expect((await response.json()) as CancelRunResult).toEqual(result);
        expect(sessions).toEqual([
            {
                identity: { user: "local" },
                scope: { kind: "analysis", analysisId: "mine" },
                provenance: { agentId: "run-cancel", callPath: ["run-cancel"] },
                auth: expect.anything(),
            },
        ]);
    });

    test("404 `not_found` for a run of a different analysis, with no cancel", async () => {
        const app = appWith({ getRun: () => okAsync(runRow({ runId: "r1", analysisId: "other" })) });
        expect((await app.request("/api/v1/analyses/mine/run/r1/cancel", { method: "POST" })).status).toBe(404);
    });

    test("404 for a run that the canceler does not know, and 500 when the engine cancel fails", async () => {
        const getRun = (): ReturnType<RunRoutesOpts["getRun"]> => okAsync(runRow({ runId: "r1", analysisId: "mine", status: "running" }));
        const unknown = appWith({ getRun, cancelRun: () => Promise.reject(new UnknownRunError("r1")) });
        expect((await unknown.request("/api/v1/analyses/mine/run/r1/cancel", { method: "POST" })).status).toBe(404);

        const engine = appWith({ getRun, cancelRun: () => Promise.reject(new Error("engine down")) });
        const response = await engine.request("/api/v1/analyses/mine/run/r1/cancel", { method: "POST" });
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ error: "internal_error", message: "The server failed to handle the request." });
    });
});

describe("GET {A}/chat-context", () => {
    test("runs the parity drive in the profile queue, then gives the profile state and the outcome", async () => {
        const analysisId = seedAnalysis();
        const inFlight: boolean[] = [];
        const app = appWith({
            ensureParity: (_runtime, analysis) => {
                inFlight.push(profileWorkInFlight(analysis.id));
                return Promise.resolve({ kind: "triggered", restarted: false, materialized: true });
            },
            loadProfile: () => okAsync(profileRow({ status: "running", startedAt: "2026-10-01T10:00:00.000Z", workflowId: "wf" })),
        });
        const body = (await (await app.request(`/api/v1/analyses/${analysisId}/chat-context`)).json()) as ChatContext;
        expect(inFlight).toEqual([true]);
        expect(profileWorkInFlight(analysisId)).toBe(false);
        expect(body).toMatchObject({
            analysisId,
            agentId: "conversation-agent",
            parity: { kind: "triggered", restarted: false },
            dataProfile: { status: "running", workflowId: "wf", startedAt: "2026-10-01T10:00:00.000Z" },
        });
    });

    test("404 `not_found` for an analysis that does not exist, with no drive", async () => {
        const response = await appWith({}).request("/api/v1/analyses/gone/chat-context");
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "not_found", message: "No analysis gone." });
    });

    test("500 `internal_error` when the drive throws", async () => {
        const analysisId = seedAnalysis();
        const app = appWith({ ensureParity: () => Promise.reject(new Error("staging blew up")) });
        expect((await app.request(`/api/v1/analyses/${analysisId}/chat-context`)).status).toBe(500);
    });

    test("a sandbox that cannot start gives the refusal as a failed parity, with no drive", async () => {
        const analysisId = seedAnalysis();
        const app = appWith({ sandboxRefusal: () => Promise.resolve(IMAGE_REFUSAL), loadProfile: () => okAsync(null) });
        const response = await app.request(`/api/v1/analyses/${analysisId}/chat-context`);
        expect(response.status).toBe(200);
        expect(((await response.json()) as ChatContext).parity).toEqual({ kind: "failed", reason: IMAGE_REFUSAL, materialized: false });
    });
});

describe("GET {A}/data-profile", () => {
    test("`status: null` for an analysis that was never profiled", async () => {
        const app = appWith({ loadProfile: () => okAsync(null) });
        expect((await (await app.request("/api/v1/analyses/x/data-profile")).json()) as DataProfileView).toEqual({ status: null });
    });

    test("the ledger row, with the usage of the profile calls", async () => {
        const analysisId = seedAnalysis();
        seedUsage(analysisId, { runId: DATA_PROFILE_RUN_LITERAL }, 42);
        const app = appWith({ loadProfile: () => okAsync(profileRow({ status: "failed", error: "no files", seedInputFileIds: ["f1"] })) });
        const view = (await (await app.request(`/api/v1/analyses/${analysisId}/data-profile`)).json()) as DataProfileView;
        expect(view).toEqual({
            status: "failed",
            error: "no files",
            startedAt: null,
            completedAt: null,
            result: null,
            workflowId: null,
            seedInputFileIds: ["f1"],
            usage: { calls: 1, inputTokens: 42 },
        });
    });

    test("a profile drive that is queued or runs shows as work that the row does not show yet", async () => {
        const app = appWith({ loadProfile: () => okAsync(null) });
        let release: () => void = () => undefined;
        const drive = serializeProfileWork("x", () => new Promise<void>((resolve) => (release = resolve)));
        expect((await (await app.request("/api/v1/analyses/x/data-profile")).json()) as DataProfileView).toEqual({ status: null, workPending: true });

        release();
        await drive;
        await Promise.sleep(0);
        expect((await (await app.request("/api/v1/analyses/x/data-profile")).json()) as DataProfileView).toEqual({ status: null });
    });

    test("an input change that waits for its re-profile shows as work, until the watch stops", async () => {
        const app = appWith({ loadProfile: () => okAsync(null) });
        let handler: (event: StampedEvent) => void = () => undefined;
        const stop = watchInputDrift({
            runtime: () => null,
            analysis: failing("analysis"),
            reprofile: failing("reprofile"),
            sandboxRefusal: failing("sandboxRefusal"),
            schedule: () => () => undefined,
            subscribe: (h) => {
                handler = h;
                return () => undefined;
            },
        });
        // The cast gives the two fields that the watch reads. The bus stamps the others.
        handler({ type: "prov.input_added", analysisId: "x" } as unknown as StampedEvent);
        expect((await (await app.request("/api/v1/analyses/x/data-profile")).json()) as DataProfileView).toEqual({ status: null, workPending: true });

        stop();
        expect((await (await app.request("/api/v1/analyses/x/data-profile")).json()) as DataProfileView).toEqual({ status: null });
    });
});

describe("POST {A}/data-profile/rerun", () => {
    test("202 with the outcome of the deliberate re-profile", async () => {
        const analysisId = seedAnalysis();
        const app = appWith({ forceReprofile: () => Promise.resolve({ kind: "already_running", materialized: false }) });
        const response = await app.request(`/api/v1/analyses/${analysisId}/data-profile/rerun`, { method: "POST" });
        expect(response.status).toBe(202);
        expect((await response.json()) as ProfileRerunResult).toEqual({ outcome: { kind: "already_running", materialized: false } });
    });

    test("409 `conflict` with the refusal when the sandbox cannot start, with no drive", async () => {
        const analysisId = seedAnalysis();
        const app = appWith({ sandboxRefusal: () => Promise.resolve(IMAGE_REFUSAL) });
        const response = await app.request(`/api/v1/analyses/${analysisId}/data-profile/rerun`, { method: "POST" });
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: "conflict", message: IMAGE_REFUSAL });
    });

    test("the drives of one analysis run one at a time, in arrival order", async () => {
        const analysisId = seedAnalysis();
        const order: string[] = [];
        let releaseFirst: () => void = () => undefined;
        const firstHeld = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const app = appWith({
            ensureParity: async () => {
                order.push("parity:start");
                await firstHeld;
                order.push("parity:end");
                return { kind: "already_profiled", materialized: true };
            },
            forceReprofile: () => {
                order.push("force");
                return Promise.resolve({ kind: "triggered", restarted: true, materialized: true });
            },
            loadProfile: () => okAsync(null),
        });
        const parity = app.request(`/api/v1/analyses/${analysisId}/chat-context`);
        const force = app.request(`/api/v1/analyses/${analysisId}/data-profile/rerun`, { method: "POST" });
        await Promise.sleep(10);
        expect(order).toEqual(["parity:start"]);
        releaseFirst();
        await Promise.all([parity, force]);
        expect(order).toEqual(["parity:start", "parity:end", "force"]);
    });
});

describe("GET {A}/sandbox-readiness", () => {
    test("the machine verdict, with the input count of the analysis", async () => {
        const analysisId = seedAnalysis();
        insertAnalysisInput({ path: "/data/a.fastq", isDir: false, analysisId, anchorId: null })._unsafeUnwrap();
        const verdict: Omit<SandboxReadiness, "inputCount"> = {
            image: { state: "absent", image: "ghcr.io/x/sandbox:1" },
            store: "installed",
            farm: { present: false, catalogPresent: true, failure: "the graph is unusable" },
        };
        const requested: string[] = [];
        const app = appWith({
            readiness: (id) => {
                requested.push(id);
                return Promise.resolve(verdict);
            },
        });
        const response = await app.request(`/api/v1/analyses/${analysisId}/sandbox-readiness`);
        expect(requested).toEqual([analysisId]);
        expect((await response.json()) as SandboxReadiness).toEqual({ ...verdict, inputCount: 1 });
    });

    test("needs no runtime", async () => {
        const app = appWith(
            {
                readiness: () =>
                    Promise.resolve({ image: { state: "present", image: "i" }, store: "local", farm: { present: true, catalogPresent: true, failure: null } }),
            },
            {
                state: () => ({ ...identity, phase: "starting", boot: { attemptStartedAt: identity.startedAt, step: null, done: [] } }),
                runtime: () => null,
                start: async () => undefined,
            },
        );
        expect((await app.request("/api/v1/analyses/x/sandbox-readiness")).status).toBe(200);
    });
});

describe("POST {A}/farm/heal", () => {
    test("202 with the outcome of the heal", async () => {
        const app = appWith({ healFarm: (id) => Promise.resolve(id === "mine" ? { kind: "composed", packages: 12 } : { kind: "no_catalog" }) });
        const response = await app.request("/api/v1/analyses/mine/farm/heal", { method: "POST" });
        expect(response.status).toBe(202);
        expect((await response.json()) as FarmHealResult).toEqual({ outcome: { kind: "composed", packages: 12 } });
    });
});

describe("POST {A}/plans/:planId/approve", () => {
    const planId = "pln-0000000a";
    const startedApproval: PlanApproval = {
        planId,
        runId: "r1",
        started: true,
        message: {
            id: "m1",
            role: "system",
            parts: [{ type: "data-plan-approval", planId, runId: "r1", approvedAt: "2026-10-13T10:00:00.000Z" }],
        },
    };

    beforeEach(() => {
        __resetTurnsForTest();
    });
    afterEach(() => {
        __resetTurnsForTest();
    });

    /** The route over a fake approval that records its inputs and gives `outcome`. */
    function approvalApp(
        outcome: () => ResultAsync<PlanApproval, ApprovePlanRefusal>,
        boot: ServerBoot = readyBoot,
    ): { app: Hono<ServerEnv>; inputs: ApprovePlanInput[] } {
        const inputs: ApprovePlanInput[] = [];
        const app = appWith(
            {
                approvePlan: (_runtime, input) => {
                    inputs.push(input);
                    return outcome();
                },
            },
            boot,
        );
        return { app, inputs };
    }

    function approve(app: Hono<ServerEnv>, analysisId: string, body: unknown = { threadId: "t1" }): Response | Promise<Response> {
        return app.request(`/api/v1/analyses/${analysisId}/plans/${planId}/approve`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });
    }

    function activityOf(analysisId: string): number | undefined {
        const page = listAnalysisPage({ projectId: null, sort: "created", limit: 100, offset: 0 })._unsafeUnwrap();
        return page.items.find((item) => item.analysis.id === analysisId)?.lastActivityAt;
    }

    test("a click on Approve gives 201 with the result, and the approval runs under the local identity and the analysis, thread, and plan of the request", async () => {
        const analysisId = seedAnalysis();
        const { app, inputs } = approvalApp(() => okAsync(startedApproval));

        const response = await approve(app, analysisId);

        expect(response.status).toBe(201);
        expect((await response.json()) as PlanApprovalResult).toEqual(startedApproval);
        expect(inputs).toHaveLength(1);
        expect(inputs[0]).toMatchObject({ analysisId, threadId: "t1", planId, identity: { user: "local" } });
        expect(inputs[0]!.auth).toBeDefined();
    });

    test("an approval that started the run raises the activity of the analysis", async () => {
        const analysisId = seedAnalysis();
        const before = activityOf(analysisId)!;
        await Bun.sleep(5);

        expect((await approve(approvalApp(() => okAsync(startedApproval)).app, analysisId)).status).toBe(201);

        expect(activityOf(analysisId)!).toBeGreaterThan(before);
    });

    test("a second click names the active run with started false and message null, and changes no activity", async () => {
        const analysisId = seedAnalysis();
        const before = activityOf(analysisId);
        const active: PlanApproval = { planId, runId: "r1", started: false, message: null };

        const response = await approve(approvalApp(() => okAsync(active)).app, analysisId);

        expect(response.status).toBe(201);
        expect(await response.json()).toEqual(active);
        expect(activityOf(analysisId)).toBe(before);
    });

    test("a running turn on the thread gives 409 `busy` with the reason, and the approval does not run", async () => {
        const analysisId = seedAnalysis();
        startTurn({ turnId: "turn-1", threadId: "t1", analysisId }, new Date());
        const { app, inputs } = approvalApp(() => okAsync(startedApproval));

        const response = await approve(app, analysisId);

        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({
            error: "busy",
            message: "Cannot approve a plan while a chat turn is running.",
            details: { reasons: ["chat_turn"] },
        });
        expect(inputs).toEqual([]);
    });

    test("a running turn on a different thread does not hold the approval", async () => {
        const analysisId = seedAnalysis();
        startTurn({ turnId: "turn-1", threadId: "t-other", analysisId }, new Date());

        expect((await approve(approvalApp(() => okAsync(startedApproval)).app, analysisId)).status).toBe(201);
    });

    test("an unknown thread and an unknown plan give 404 `not_found`", async () => {
        const analysisId = seedAnalysis();

        const thread = await approve(approvalApp(() => errAsync({ type: "thread_not_found" })).app, analysisId);
        const plan = await approve(approvalApp(() => errAsync({ type: "plan_not_found", planId })).app, analysisId);

        expect(thread.status).toBe(404);
        expect(await thread.json()).toEqual({ error: "not_found", message: "Thread not found." });
        expect(plan.status).toBe(404);
        expect(await plan.json()).toEqual({ error: "not_found", message: `This analysis has no plan ${planId}.` });
    });

    test("each refusal of the plan and of the launch gives 409 `conflict` with its reason and data", async () => {
        const analysisId = seedAnalysis();
        const cases: Array<[ApprovePlanRefusal, string, unknown]> = [
            [
                { type: "superseded", supersededBy: "pln-0000000b" },
                `Plan ${planId} was replaced by plan pln-0000000b.`,
                { reason: "superseded", supersededBy: "pln-0000000b" },
            ],
            [
                { type: "plan_invalid", planId, malformed: false, errors: ["Step a has no agent"] },
                `Plan ${planId} is not valid.`,
                { reason: "plan_invalid", errors: ["Step a has no agent"] },
            ],
            [
                { type: "packages_missing", missing: ["scanpy"], collisions: ["xgboost"] },
                `The packages of plan ${planId} cannot link.`,
                { reason: "packages_missing", missing: ["scanpy"], collisions: ["xgboost"] },
            ],
            [
                { type: "packages_missing", missing: [], collisions: [], unavailable: "the farm is locked" },
                `The packages of plan ${planId} cannot link.`,
                { reason: "packages_missing", missing: [], collisions: [], unavailable: "the farm is locked" },
            ],
            [{ type: "not_authorized", reason: "mint refused" }, "The run was not authorized: mint refused", { reason: "not_authorized" }],
            [{ type: "suspended", reason: "no_funds" }, "The analysis is suspended: no_funds", { reason: "suspended" }],
        ];

        for (const [refusal, message, details] of cases) {
            const response = await approve(approvalApp(() => errAsync(refusal)).app, analysisId);

            expect(response.status).toBe(409);
            expect(await response.json()).toEqual({ error: "conflict", message, details });
        }
    });

    test("a failed store and a failed start give 500 `internal_error` with no cause in the body", async () => {
        const analysisId = seedAnalysis();
        const refusals: ApprovePlanRefusal[] = [
            { type: "store_failed", cause: { type: "query_failed", op: "plans.loadPlan", cause: new Error("secret store detail") } },
            { type: "launch_failed", cause: new Error("secret launch detail") },
        ];

        for (const refusal of refusals) {
            const response = await approve(approvalApp(() => errAsync(refusal)).app, analysisId);

            expect(response.status).toBe(500);
            const text = await response.text();
            expect(JSON.parse(text)).toMatchObject({ error: "internal_error" });
            expect(text).not.toContain("secret");
        }
    });

    test("a body with no thread id, an empty thread id, and a body that is not JSON give 400, and the approval does not run", async () => {
        const analysisId = seedAnalysis();
        const { app, inputs } = approvalApp(() => okAsync(startedApproval));

        for (const body of [{}, { threadId: "" }, { threadId: 7 }]) {
            const response = await approve(app, analysisId, body);
            expect(response.status).toBe(400);
            expect(await response.json()).toMatchObject({ error: "validation_error" });
        }
        const notJson = await app.request(`/api/v1/analyses/${analysisId}/plans/${planId}/approve`, { method: "POST", body: "not json" });
        expect(notJson.status).toBe(400);
        expect(await notJson.json()).toMatchObject({ error: "invalid_json" });
        expect(inputs).toEqual([]);
    });

    test("a stopping server gives 503 `draining` before it reads the body, and no run starts", async () => {
        const analysisId = seedAnalysis();
        const { app, inputs } = approvalApp(() => okAsync(startedApproval));
        refuseNewTurns();

        const response = await app.request(`/api/v1/analyses/${analysisId}/plans/${planId}/approve`, { method: "POST" });

        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ error: "draining" });
        expect(inputs).toEqual([]);
    });

    test("503 `unavailable` while the runtime boots, and the approval does not run", async () => {
        const starting: ServerBootState = { ...identity, phase: "starting", boot: { attemptStartedAt: identity.startedAt, step: null, done: [] } };
        const { app, inputs } = approvalApp(() => okAsync(startedApproval), { state: () => starting, runtime: () => null, start: async () => undefined });

        const response = await approve(app, "a1");

        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ error: "unavailable", details: { phase: "starting" } });
        expect(inputs).toEqual([]);
    });

    test("the default binding calls the approval of the runtime", async () => {
        const analysisId = seedAnalysis();
        const calls: ApprovePlanInput[] = [];
        const bound = {
            pool,
            approvePlan: (input: ApprovePlanInput) => {
                calls.push(input);
                return okAsync(startedApproval);
            },
        } as unknown as HarnessRuntime;

        const result = await DEFAULT_RUN_ROUTES_OPTS.approvePlan(bound, { analysisId, threadId: "t1", planId, identity: { user: "local" }, auth: {} });

        expect(result._unsafeUnwrap()).toEqual(startedApproval);
        expect(calls).toHaveLength(1);
    });
});
