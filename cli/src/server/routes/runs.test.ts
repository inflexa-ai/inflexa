import { beforeEach, describe, expect, test } from "bun:test";
import { randomUUIDv7 } from "bun";
import { Hono } from "hono";
import { errAsync, okAsync } from "neverthrow";
import {
    createRunEventStream,
    UnknownRunError,
    type AgentSession,
    type CortexRunRow,
    type DataProfileStatus,
    type Pool,
    type StepExecutionRow,
} from "@inflexa-ai/harness";

import { DATA_PROFILE_RUN_LITERAL } from "@inflexa-ai/harness/contracts/index.js";

import type {
    CancelRunResult,
    ChatContext,
    DataProfileView,
    FarmHealResult,
    ProfileRerunResult,
    RunDetail,
    RunList,
    SandboxReadiness,
} from "../../api/runs.ts";
import type { ServerState } from "../../api/server.ts";
import { insertAnalysis, insertAnalysisInput, insertAnchor, upsertLlmUsage } from "../../db/primary_mutation.ts";
import { asStr256 } from "../../lib/types.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import type { StampedEvent } from "../../types/events.ts";
import { freshDb } from "../../test_support/db.ts";
import type { ServerBoot } from "../boot.ts";
import type { ServerEnv } from "../http.ts";
import { __resetProfileQueueForTest, profileWorkInFlight, serializeProfileWork, watchInputDrift } from "../profile_queue.ts";
import { runRoutes, type RunRoutesOpts } from "./runs.ts";

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
    listSteps: failing("listSteps"),
    loadPlan: failing("loadPlan"),
    loadProfile: failing("loadProfile"),
    subscribeRun: failing("subscribeRun"),
    cancelRun: failing("cancelRun"),
    ensureParity: failing("ensureParity"),
    forceReprofile: failing("forceReprofile"),
    readiness: failing("readiness"),
    sandboxRefusal: failing("sandboxRefusal"),
    healFarm: failing("healFarm"),
};

/** The routes over a sandbox that can start, unless `opts` gives a refusal. */
function appWith(opts: Partial<RunRoutesOpts>, boot: ServerBoot = readyBoot): Hono<ServerEnv> {
    return new Hono<ServerEnv>().route(
        "/api/v1/analyses/:analysisId",
        runRoutes(boot, { ...UNEXPECTED, sandboxRefusal: () => Promise.resolve(null), ...opts }),
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
        const active = [runRow({ runId: "a1", analysisId, status: "running" }), runRow({ runId: "a2", analysisId, status: "suspended_insufficient_funds" })];
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
        const starting: ServerState = { ...identity, phase: "starting" };
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

    test("404 `not_found` for a run of a different analysis, and for an unknown run", async () => {
        const foreign = appWith({ getRun: () => okAsync(runRow({ runId: "r1", analysisId: "other" })) });
        const response = await foreign.request("/api/v1/analyses/mine/run/r1");
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "not_found", message: "This analysis has no run r1." });

        const unknown = appWith({ getRun: () => okAsync(null) });
        expect((await unknown.request("/api/v1/analyses/mine/run/r1")).status).toBe(404);
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
                createRunEventStream({ pool: p, readRunStatus: () => okAsync("canceled"), sleep: async () => undefined }).subscribe(options),
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
            { state: () => ({ ...identity, phase: "starting" }), runtime: () => null, start: async () => undefined },
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
