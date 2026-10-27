import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUIDv7 } from "bun";
import { Hono } from "hono";
import { err, errAsync, ok, okAsync } from "neverthrow";
import type { AskGateway, EndedRunSummary, PendingAsk, Pool, RunProgressSummary, Thread } from "@inflexa-ai/harness";

import type { Attention } from "../../api/attention.ts";
import type { ServerBootState } from "../../api/server.ts";
import type { DbError } from "../../db/errors.ts";
import { db } from "../../db/primary.ts";
import { insertAnalysis, insertAnchor } from "../../db/primary_mutation.ts";
import { asStr256 } from "../../lib/types.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import { freshDb } from "../../test_support/db.ts";
import { conversationThread } from "../../test_support/threads.ts";
import type { ServerBoot } from "../boot.ts";
import type { ServerEnv } from "../http.ts";
import { __resetTurnsForTest, startTurn } from "../turns.ts";
import { attentionRoutes, DEFAULT_ATTENTION_ROUTE_OPTS, type AttentionRouteOpts } from "./attention.ts";
import { runRoutes, type RunRoutesOpts } from "./runs.ts";

// The routes under their mount paths, with no bearer check and no guard: `app.test.ts` covers those. Each read
// of Postgres is a fake that records its calls, and the SQLite reads run on the test database. Each `as` cast of
// a body below reads JSON that the route under test builds from the same `src/api/` type.

const identity = { version: "0.0.0-test", apiVersion: 1, startedAt: "2026-10-02T00:00:00.000Z" } as const;
const BASELINE = "2026-10-05T00:00:00.000Z";

/** An ask gateway over a fixed pending set. Only `pending` is read, and `pendingReads` counts its calls. */
function gatewayOf(pending: () => Promise<PendingAsk[]>): AskGateway {
    const never = (): Promise<never> => Promise.reject(new Error("the routes only read the pending asks"));
    return { raise: never, expire: never, abort: never, answer: never, pending, sweepExpired: () => Promise.resolve(0) };
}

function readyBoot(gateway: AskGateway): ServerBoot {
    // The cast is sound: the routes under test read the pool and the gateway of the runtime, and nothing else.
    const runtime = { pool: {} as unknown as Pool, askGateway: gateway } as unknown as HarnessRuntime;
    const state: ServerBootState = { ...identity, phase: "ready", connection: { provider: "anthropic", mode: "cliproxy", model: "m" } };
    return { state: () => state, runtime: () => runtime, start: async () => undefined };
}

/** A new analysis row with the given name in the test database. */
function seedAnalysis(name: string): string {
    const now = Date.now();
    const anchorId = randomUUIDv7();
    insertAnchor({ id: anchorId, createdAt: now, updatedAt: now, cachedPath: `/tmp/${anchorId}`, markerWritten: false, lastSeen: now })._unsafeUnwrap();
    const id = randomUUIDv7();
    insertAnalysis({ id, createdAt: now, updatedAt: now, name: asStr256(name), slug: `${name}-${id}`, anchorId, projectId: null })._unsafeUnwrap();
    return id;
}

/** Pin the seen baseline, so a case names a run that ended before it or after it. */
function setBaseline(iso: string): void {
    db()
        ._unsafeUnwrap()
        .run("UPDATE run_seen_baseline SET since = ?", [Date.parse(iso)]);
}

function ask(id: string, analysisId: string, threadId: string | null, createdAt = "2026-10-06T10:00:00.000Z"): PendingAsk {
    return { id, analysisId, userId: "local", threadId, title: "Run a command", command: "ls", detail: null, createdAt };
}

function progress(runId: string, analysisId: string, over: Partial<RunProgressSummary> = {}): RunProgressSummary {
    return {
        analysisId,
        runId,
        status: "running",
        planTitle: "Liver DE",
        doneSteps: 1,
        totalSteps: 4,
        startedAt: "2026-10-06T09:00:00.000Z",
        completedAt: null,
        threadId: "t1",
        ...over,
    };
}

function ended(runId: string, analysisId: string, completedAt: string, status: EndedRunSummary["status"] = "completed"): EndedRunSummary {
    return { analysisId, runId, status, completedAt };
}

/** The fakes of a case, and the calls that the route made on each. */
type Fixture = {
    pending: PendingAsk[];
    live: string[];
    progress: RunProgressSummary[];
    ended: EndedRunSummary[];
    threads: Thread[];
};

type Calls = {
    asks: number;
    live: number;
    progress: string[][];
    ended: { since: string; limit: number }[];
    threads: { limit: number; type?: string }[];
};

function emptyFixture(): Fixture {
    return { pending: [], live: [], progress: [], ended: [], threads: [] };
}

/** The route over fakes of the Postgres reads. The fake ledger of ended runs applies `since` and the limit, as the read does. */
function appOver(fixture: Fixture, over: Partial<AttentionRouteOpts> = {}, runOpts?: Partial<RunRoutesOpts>): { app: Hono<ServerEnv>; calls: Calls } {
    const calls: Calls = { asks: 0, live: 0, progress: [], ended: [], threads: [] };
    const gateway = gatewayOf(() => {
        calls.asks += 1;
        return Promise.resolve(fixture.pending);
    });
    const opts: AttentionRouteOpts = {
        ...DEFAULT_ATTENTION_ROUTE_OPTS,
        pendingAsks: (runtime) => runtime.askGateway.pending(),
        liveRunIds: () => {
            calls.live += 1;
            return okAsync(fixture.live);
        },
        runProgress: (_pool, runIds) => {
            calls.progress.push(runIds);
            return okAsync(fixture.progress.filter((entry) => runIds.includes(entry.runId)));
        },
        endedRuns: (_pool, input) => {
            calls.ended.push(input);
            const rows = fixture.ended
                .filter((row) => row.completedAt >= input.since)
                .sort((a, b) => (a.completedAt === b.completedAt ? b.runId.localeCompare(a.runId) : b.completedAt.localeCompare(a.completedAt)));
            return okAsync(rows.slice(0, input.limit));
        },
        recentThreads: (_pool, input) => {
            calls.threads.push(input);
            return okAsync(fixture.threads.slice(0, input.limit));
        },
        ...over,
    };
    const boot = readyBoot(gateway);
    const app = new Hono<ServerEnv>();
    app.route("/api/v1/attention", attentionRoutes(boot, opts));
    if (runOpts !== undefined) {
        app.route(
            "/api/v1/analyses/:analysisId",
            runRoutes(boot, {
                listRuns: () => errAsync({ type: "query_failed", op: "test", cause: "unused" }),
                listThreadRuns: () => errAsync({ type: "query_failed", op: "test", cause: "unused" }),
                listActiveRuns: () => errAsync({ type: "query_failed", op: "test", cause: "unused" }),
                getRun: () => okAsync(null),
                countArtifacts: () => errAsync({ type: "query_failed", op: "test", cause: "unused" }),
                readSynthesis: () => Promise.resolve(null),
                listSteps: () => errAsync({ type: "query_failed", op: "test", cause: "unused" }),
                loadPlan: () => okAsync(null),
                loadPlanRecord: () => okAsync(null),
                listPlanRunIds: () => okAsync([]),
                loadProfile: () => okAsync(null),
                subscribeRun: () => Promise.resolve(),
                cancelRun: () => Promise.reject(new Error("unused")),
                ensureParity: () => Promise.reject(new Error("unused")),
                forceReprofile: () => Promise.reject(new Error("unused")),
                readiness: () => Promise.reject(new Error("unused")),
                sandboxRefusal: () => Promise.resolve(null),
                healFarm: () => Promise.reject(new Error("unused")),
                approvePlan: () => errAsync({ type: "thread_not_found" }),
                ...runOpts,
            }),
        );
    }
    return { app, calls };
}

async function attentionOf(app: Hono<ServerEnv>, query = ""): Promise<Attention> {
    const response = await app.request(`/api/v1/attention${query}`);
    expect(response.status).toBe(200);
    return (await response.json()) as Attention;
}

beforeEach(() => {
    freshDb();
    setBaseline(BASELINE);
});

afterEach(() => {
    __resetTurnsForTest();
});

describe("GET /api/v1/attention", () => {
    test("an open ask in one analysis and a live run in a different analysis give both, with the names", async () => {
        const a1 = seedAnalysis("trial");
        const a2 = seedAnalysis("bulk");
        const fixture = emptyFixture();
        fixture.pending = [ask("k1", a1, "t1")];
        fixture.live = ["r1"];
        fixture.progress = [progress("r1", a2, { threadId: "t2", planTitle: "Liver DE", doneSteps: 2, totalSteps: 5 })];

        const body = await attentionOf(appOver(fixture).app);

        expect(body.asks).toEqual([
            {
                askId: "k1",
                analysisId: a1,
                analysisName: "trial",
                threadId: "t1",
                title: "Run a command",
                command: "ls",
                createdAt: "2026-10-06T10:00:00.000Z",
                stale: true,
            },
        ]);
        expect(body.activeRuns).toEqual([
            {
                runId: "r1",
                analysisId: a2,
                analysisName: "bulk",
                threadId: "t2",
                planTitle: "Liver DE",
                doneSteps: 2,
                totalSteps: 5,
                startedAt: "2026-10-06T09:00:00.000Z",
            },
        ]);
        expect(body.unseenRuns).toEqual([]);
        expect(body.recentThreads).toEqual([]);
    });

    test("an ask whose thread has no running turn is stale, an ask with a running turn is not, and an ask with no thread is stale", async () => {
        const a1 = seedAnalysis("trial");
        startTurn({ turnId: "turn-1", threadId: "t-running", analysisId: a1 }, new Date(), new AbortController());
        const fixture = emptyFixture();
        fixture.pending = [ask("idle", a1, "t-idle"), ask("running", a1, "t-running"), ask("orphan", a1, null)];

        const body = await attentionOf(appOver(fixture).app);

        expect(body.asks.map((item) => [item.askId, item.stale])).toEqual([
            ["idle", true],
            ["running", false],
            ["orphan", true],
        ]);
        expect(body.asks[2]?.threadId).toBeNull();
    });

    test("a seen run and a run that ended before the baseline are absent from unseenRuns", async () => {
        const a1 = seedAnalysis("trial");
        db()._unsafeUnwrap().run("INSERT INTO run_seen_marks (run_id, seen_at, analysis_id) VALUES ('r-seen', 1, ?)", [a1]);
        const fixture = emptyFixture();
        fixture.ended = [
            ended("r-old", a1, "2026-10-04T23:59:59.999Z"),
            ended("r-seen", a1, "2026-10-06T08:00:00.000Z"),
            ended("r-new", a1, "2026-10-06T09:00:00.000Z", "failed"),
        ];
        const { app, calls } = appOver(fixture);

        const body = await attentionOf(app);

        expect(body.unseenRuns).toEqual([{ runId: "r-new", analysisId: a1, analysisName: "trial", status: "failed", completedAt: "2026-10-06T09:00:00.000Z" }]);
        expect(calls.ended).toEqual([{ since: BASELINE, limit: 200 }]);
    });

    test("the seen marks bound no read: the ended read gets no id list, and the seen lookup gets only the ids of the page", async () => {
        const a1 = seedAnalysis("trial");
        const conn = db()._unsafeUnwrap();
        for (let i = 0; i < 300; i++) conn.run("INSERT INTO run_seen_marks (run_id, seen_at, analysis_id) VALUES (?, 1, ?)", [`r-gone-${i}`, a1]);
        conn.run("INSERT INTO run_seen_marks (run_id, seen_at, analysis_id) VALUES ('r-old-seen', 1, ?)", [a1]);
        conn.run("INSERT INTO run_seen_marks (run_id, seen_at, analysis_id) VALUES ('r-page-seen', 1, ?)", [a1]);
        const fixture = emptyFixture();
        fixture.ended.push(ended("r-old-seen", a1, "2026-10-06T00:00:00.000Z"));
        for (let i = 0; i < 199; i++) fixture.ended.push(ended(`r-page-${String(i).padStart(3, "0")}`, a1, "2026-10-07T00:00:00.000Z"));
        fixture.ended.push(ended("r-page-seen", a1, "2026-10-07T00:00:00.000Z"));
        const lookups: (readonly string[])[] = [];
        const { app, calls } = appOver(fixture, {
            seenRunIds: (runIds) => {
                lookups.push(runIds);
                return DEFAULT_ATTENTION_ROUTE_OPTS.seenRunIds(runIds);
            },
        });

        const body = await attentionOf(app);

        expect(calls.ended).toEqual([{ since: BASELINE, limit: 200 }]);
        expect(lookups).toHaveLength(1);
        expect(lookups[0]).toHaveLength(200);
        expect(lookups[0]).toContain("r-page-seen");
        expect(lookups[0]).not.toContain("r-old-seen");
        expect(body.unseenRuns).toHaveLength(199);
        expect(body.unseenRuns.map((item) => item.runId)).not.toContain("r-page-seen");
    });

    test("an absent baseline row gives an empty unseenRuns and sends no ended-run read", async () => {
        const a1 = seedAnalysis("trial");
        db()._unsafeUnwrap().run("DELETE FROM run_seen_baseline");
        const fixture = emptyFixture();
        fixture.ended = [ended("r-new", a1, "2026-10-06T09:00:00.000Z")];
        const { app, calls } = appOver(fixture);

        const body = await attentionOf(app);

        expect(body.unseenRuns).toEqual([]);
        expect(calls.ended).toEqual([]);
    });

    test("a seen baseline that is not a time gives an empty unseenRuns and sends no ended-run read", async () => {
        const a1 = seedAnalysis("trial");
        const fixture = emptyFixture();
        fixture.ended = [ended("r-new", a1, "2026-10-06T09:00:00.000Z")];
        const { app, calls } = appOver(fixture, { seenBaseline: () => ok<number | null, DbError>(Number.NaN) });

        const body = await attentionOf(app);

        expect(body.unseenRuns).toEqual([]);
        expect(calls.ended).toEqual([]);
    });

    test("a run whose progress entry is terminal is absent from activeRuns", async () => {
        const a1 = seedAnalysis("trial");
        const fixture = emptyFixture();
        fixture.live = ["r-running", "r-just-ended"];
        fixture.progress = [progress("r-running", a1), progress("r-just-ended", a1, { status: "completed", completedAt: "2026-10-06T09:30:00.000Z" })];

        const body = await attentionOf(appOver(fixture).app);

        expect(body.activeRuns.map((item) => item.runId)).toEqual(["r-running"]);
    });

    test("recentThreads asks for the conversation threads, and its items carry the turn, the asks, and the analysis name", async () => {
        const a1 = seedAnalysis("trial");
        startTurn({ turnId: "turn-1", threadId: "t1", analysisId: a1 }, new Date(), new AbortController());
        const fixture = emptyFixture();
        fixture.pending = [ask("k1", a1, "t1"), ask("k2", a1, "t1")];
        fixture.threads = [conversationThread({ threadId: "t1", analysisId: a1 }), conversationThread({ threadId: "t2", analysisId: a1 })];
        const { app, calls } = appOver(fixture);

        const body = await attentionOf(app);

        expect(calls.threads).toEqual([{ limit: 10, type: "conversation" }]);
        expect(body.recentThreads.map((item) => [item.id, item.analysisName, item.runningTurnId, item.pendingAsks])).toEqual([
            ["t1", "trial", "turn-1", 2],
            ["t2", "trial", null, 0],
        ]);
        expect(body.recentThreads[0]).toMatchObject({ resourceId: a1, threadType: "conversation" });
    });

    test("after POST {A}/run/:runId/seen, the run leaves unseenRuns", async () => {
        const a1 = seedAnalysis("trial");
        const fixture = emptyFixture();
        fixture.ended = [ended("r1", a1, "2026-10-06T09:00:00.000Z"), ended("r2", a1, "2026-10-06T08:00:00.000Z")];
        const { app } = appOver(
            fixture,
            {},
            {
                getRun: () =>
                    okAsync({
                        runId: "r1",
                        threadId: null,
                        analysisId: a1,
                        workflowName: "executeAnalysis",
                        status: "completed",
                        startedAt: "2026-10-06T08:00:00.000Z",
                        completedAt: "2026-10-06T09:00:00.000Z",
                        error: null,
                        synthesisStatus: null,
                        synthesisReason: null,
                        parts: null,
                        mandateJti: null,
                        mandateExpiresAt: null,
                        planId: null,
                    }),
            },
        );
        expect((await attentionOf(app)).unseenRuns.map((item) => item.runId)).toEqual(["r1", "r2"]);

        const marked = await app.request(`/api/v1/analyses/${a1}/run/r1/seen`, { method: "POST" });
        expect(marked.status).toBe(200);

        expect((await attentionOf(app)).unseenRuns.map((item) => item.runId)).toEqual(["r2"]);
    });

    test("an item of an analysis with no SQLite row is absent from each list", async () => {
        const a1 = seedAnalysis("trial");
        const fixture = emptyFixture();
        fixture.pending = [ask("k-ok", a1, "t1"), ask("k-orphan", "ghost", "t9")];
        fixture.live = ["r-ok", "r-orphan"];
        fixture.progress = [progress("r-ok", a1), progress("r-orphan", "ghost")];
        fixture.ended = [ended("e-ok", a1, "2026-10-06T09:00:00.000Z"), ended("e-orphan", "ghost", "2026-10-06T09:00:00.000Z")];
        fixture.threads = [conversationThread({ threadId: "t-ok", analysisId: a1 }), conversationThread({ threadId: "t-orphan", analysisId: "ghost" })];

        const body = await attentionOf(appOver(fixture).app);

        expect(body.asks.map((item) => item.askId)).toEqual(["k-ok"]);
        expect(body.activeRuns.map((item) => item.runId)).toEqual(["r-ok"]);
        expect(body.unseenRuns.map((item) => item.runId)).toEqual(["e-ok"]);
        expect(body.recentThreads.map((item) => item.id)).toEqual(["t-ok"]);
    });

    test("limit gives 10 by default and for 0, -1, 2.5, and abc; a valid value passes; a larger value than 200 gives 200", async () => {
        const { app, calls } = appOver(emptyFixture());

        for (const query of ["", "?limit=0", "?limit=-1", "?limit=2.5", "?limit=abc", "?limit="]) await attentionOf(app, query);
        await attentionOf(app, "?limit=5");
        await attentionOf(app, "?limit=200");
        await attentionOf(app, "?limit=1000");

        expect(calls.threads.map((input) => input.limit)).toEqual([10, 10, 10, 10, 10, 10, 5, 200, 200]);
    });

    test("activeRuns and unseenRuns read at most 200 items", async () => {
        const limits: number[] = [];
        const { app, calls } = appOver(emptyFixture(), {
            liveRunIds: (_pool, limit) => {
                limits.push(limit);
                return okAsync([]);
            },
        });

        await attentionOf(app);

        expect(limits).toEqual([200]);
        expect(calls.ended.map((input) => input.limit)).toEqual([200]);
    });

    test("the route gives 503 `unavailable` while the server boots", async () => {
        const startedAt = identity.startedAt;
        const starting: ServerBootState = { ...identity, phase: "starting", boot: { attemptStartedAt: startedAt, step: null, done: [] } };
        const app = new Hono<ServerEnv>().route(
            "/api/v1/attention",
            attentionRoutes({ state: () => starting, runtime: () => null, start: async () => undefined }),
        );

        const response = await app.request("/api/v1/attention");

        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ error: "unavailable", details: { phase: "starting" } });
    });

    test("a failed read gives 500 `internal_error`, whichever read fails", async () => {
        const failure = { type: "query_failed", op: "test", cause: "down" } as const;
        const failing: Partial<AttentionRouteOpts>[] = [
            { pendingAsks: () => Promise.reject(new Error("ledger down")) },
            { liveRunIds: () => errAsync(new Error("workflow table down")) },
            { runProgress: () => errAsync(failure) },
            { endedRuns: () => errAsync(failure) },
            { recentThreads: () => errAsync(failure) },
            { analysisNames: () => err<Map<string, string>, DbError>({ type: "query_failed", op: "test", cause: "down" }) },
            { seenBaseline: () => err<number | null, DbError>({ type: "query_failed", op: "test", cause: "down" }) },
            { seenRunIds: () => err<Set<string>, DbError>({ type: "query_failed", op: "test", cause: "down" }) },
        ];
        const a1 = seedAnalysis("trial");
        const fixture = emptyFixture();
        fixture.live = ["r1"];
        fixture.progress = [progress("r1", a1)];

        for (const over of failing) {
            const response = await appOver(fixture, over).app.request("/api/v1/attention");
            expect(response.status).toBe(500);
            expect(await response.json()).toEqual({ error: "internal_error", message: "The server failed to handle the request." });
        }
    });

    test("no live run sends no progress read", async () => {
        const { app, calls } = appOver(emptyFixture());

        await attentionOf(app);

        expect(calls.live).toBe(1);
        expect(calls.progress).toEqual([]);
    });

    test("the count of each read is the same for 1 analysis and for 20 analyses", async () => {
        const reads = { names: 0, baseline: 0, seenIds: 0 };
        const countedOver: Partial<AttentionRouteOpts> = {
            analysisNames: (ids) => {
                reads.names += 1;
                return DEFAULT_ATTENTION_ROUTE_OPTS.analysisNames(ids);
            },
            seenBaseline: () => {
                reads.baseline += 1;
                return DEFAULT_ATTENTION_ROUTE_OPTS.seenBaseline();
            },
            seenRunIds: (runIds) => {
                reads.seenIds += 1;
                return DEFAULT_ATTENTION_ROUTE_OPTS.seenRunIds(runIds);
            },
        };
        function fixtureOf(count: number): Fixture {
            const fixture = emptyFixture();
            for (let i = 0; i < count; i++) {
                const id = seedAnalysis(`analysis-${count}-${i}`);
                fixture.pending.push(ask(`k-${count}-${i}`, id, `t-${i}`));
                fixture.live.push(`r-${count}-${i}`);
                fixture.progress.push(progress(`r-${count}-${i}`, id));
                fixture.ended.push(ended(`e-${count}-${i}`, id, "2026-10-06T09:00:00.000Z"));
                fixture.threads.push(conversationThread({ threadId: `t-${count}-${i}`, analysisId: id }));
            }
            return fixture;
        }
        const summarize = (calls: Calls): unknown => ({
            asks: calls.asks,
            live: calls.live,
            progress: calls.progress.length,
            ended: calls.ended.length,
            threads: calls.threads.length,
        });

        const single = appOver(fixtureOf(1), countedOver);
        await attentionOf(single.app);
        const singleReads = { ...reads };
        reads.names = 0;
        reads.baseline = 0;
        reads.seenIds = 0;
        const many = appOver(fixtureOf(20), countedOver);
        const body = await attentionOf(many.app);

        expect(body.asks).toHaveLength(20);
        expect(body.recentThreads).toHaveLength(10);
        expect(summarize(many.calls)).toEqual(summarize(single.calls));
        expect(summarize(many.calls)).toEqual({ asks: 1, live: 1, progress: 1, ended: 1, threads: 1 });
        expect(reads).toEqual(singleReads);
        expect(reads).toEqual({ names: 1, baseline: 1, seenIds: 1 });
    });
});
