import {
    createThreadStore,
    queryRunProgressByRuns,
    queryRunsEndedSince,
    type DbError as PgError,
    type EndedRunSummary,
    type ListRecentThreadsInput,
    type PendingAsk,
    type Pool,
    type RunProgressSummary,
    type Thread,
} from "@inflexa-ai/harness";
import { Hono } from "hono";
import { okAsync, Result, ResultAsync } from "neverthrow";

import type { Attention, AttentionActiveRun, AttentionAsk, AttentionThread, AttentionUnseenRun } from "../../api/attention.ts";
import { MAX_PER_PAGE } from "../../api/common.ts";
import type { DbError } from "../../db/errors.ts";
import { getRunSeenBaseline, listAnalysisNames, listSeenRunIds } from "../../db/primary_query.ts";
import { getLogger } from "../../lib/log.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import type { ServerBoot } from "../boot.ts";
import { listLiveRunIds, listLiveTurns, type LiveTurn } from "../durable_work.ts";
import { internalError, parseCount, requireRuntime, type ServerEnv } from "../http.ts";
import { runningTurnsOf, threadActivityOf, toThreadSummary } from "./conversation.ts";
import { isTerminalRunStatus } from "./runs.ts";

/** The count of `recentThreads` when the request names none. */
const DEFAULT_RECENT_THREADS_LIMIT = 10;

/** Each read of an attention request. Tests replace each one, because the reads need Postgres or the SQLite file. */
export type AttentionRouteOpts = {
    /** Each pending ask of the runtime. It rejects on a failure. */
    readonly pendingAsks: (runtime: HarnessRuntime) => Promise<readonly PendingAsk[]>;
    /** The id of each run with a live workflow, the newest start first, at most `limit`. */
    readonly liveRunIds: (pool: Pool, limit: number) => ResultAsync<string[], unknown>;
    /** The progress of each run of the list, in one read. */
    readonly runProgress: (pool: Pool, runIds: string[]) => ResultAsync<RunProgressSummary[], PgError>;
    /** The newest `limit` terminal runs that ended at or after `since`. */
    readonly endedRuns: (pool: Pool, input: { since: string; limit: number }) => ResultAsync<EndedRunSummary[], PgError>;
    /** The newest live threads over each analysis. */
    readonly recentThreads: (pool: Pool, input: ListRecentThreadsInput) => ResultAsync<Thread[], PgError>;
    /** The seen baseline in epoch milliseconds, or `null` when its row is gone. */
    readonly seenBaseline: () => Result<number | null, DbError>;
    /** The ids of the list that have a seen mark. */
    readonly seenRunIds: (runIds: readonly string[]) => Result<Set<string>, DbError>;
    /** The name of each analysis of the list that has a row. */
    readonly analysisNames: (ids: readonly string[]) => Result<Map<string, string>, DbError>;
    /** The turn of each thread of the list whose durable workflow is live. */
    readonly liveTurns: (pool: Pool, threadIds: readonly string[]) => ResultAsync<LiveTurn[], unknown>;
};

/** The production {@link AttentionRouteOpts}. */
export const DEFAULT_ATTENTION_ROUTE_OPTS: AttentionRouteOpts = {
    pendingAsks: (runtime) => runtime.askGateway.pending(),
    liveRunIds: listLiveRunIds,
    runProgress: queryRunProgressByRuns,
    endedRuns: queryRunsEndedSince,
    recentThreads: (pool, input) => createThreadStore(pool).listRecentThreads(input),
    seenBaseline: getRunSeenBaseline,
    seenRunIds: listSeenRunIds,
    analysisNames: listAnalysisNames,
    liveTurns: listLiveTurns,
};

/**
 * The attention read (`GET /api/v1/attention`): the open asks, the runs that run, the runs that ended and that
 * the person did not mark as seen, and the newest threads, over each analysis. It reads Postgres, thus it waits
 * for the boot. The count of the reads is fixed whatever the count of analyses, and each read is bounded whatever
 * the count of seen marks: the unseen runs come from the newest {@link MAX_PER_PAGE} ended runs since the
 * baseline, thus an unseen run that is older than that window is absent.
 */
export function attentionRoutes(boot: ServerBoot, opts: AttentionRouteOpts = DEFAULT_ATTENTION_ROUTE_OPTS): Hono<ServerEnv> {
    const routes = new Hono<ServerEnv>();
    const runtimeGate = requireRuntime(boot);

    routes.get("/", runtimeGate, async (c) => {
        const runtime = c.get("runtime");
        const pool = runtime.pool;
        const limit = parseCount(c.req.query("limit"), DEFAULT_RECENT_THREADS_LIMIT);

        const baseline = opts.seenBaseline();
        if (baseline.isErr()) return internalError(c, baseline.error, "read the seen baseline");
        const since = seenSinceOf(baseline.value);
        if (since === null) getLogger("server").warn("the seen baseline is absent, thus the unseen runs read is empty");

        // The four reads start together. The progress read waits for the live run ids.
        const asks = ResultAsync.fromPromise(opts.pendingAsks(runtime), (cause) => cause);
        const live = opts
            .liveRunIds(pool, MAX_PER_PAGE)
            .andThen((ids) => (ids.length === 0 ? okAsync<RunProgressSummary[], unknown>([]) : opts.runProgress(pool, ids)));
        const ended = since === null ? okAsync<EndedRunSummary[], unknown>([]) : opts.endedRuns(pool, { since, limit: MAX_PER_PAGE });
        const threads = opts.recentThreads(pool, { limit, type: "conversation" });
        const read = Result.combine(await Promise.all([asks, live, ended, threads]));
        if (read.isErr()) return internalError(c, read.error, "read the attention lists");
        const [pending, progress, endedRuns, recent] = read.value;

        const seen = opts.seenRunIds(endedRuns.map((entry) => entry.runId));
        if (seen.isErr()) return internalError(c, seen.error, "read the seen marks");
        const unseen = endedRuns.filter((entry) => !seen.value.has(entry.runId));

        // A run that ended between the live-run read and the progress read has a terminal status here.
        const running = progress.filter((entry) => !isTerminalRunStatus(entry.status));
        const names = opts.analysisNames([
            ...pending.map((ask) => ask.analysisId),
            ...running.map((entry) => entry.analysisId),
            ...unseen.map((entry) => entry.analysisId),
            ...recent.map((thread) => thread.analysisId),
        ]);
        if (names.isErr()) return internalError(c, names.error, "read the analysis names");

        const threadIds = new Set([...recent.map((thread) => thread.threadId), ...pending.flatMap((ask) => (ask.threadId === null ? [] : [ask.threadId]))]);
        const turns = await opts.liveTurns(pool, [...threadIds]);
        if (turns.isErr()) return internalError(c, turns.error, "read the live turns");
        const runningTurns = runningTurnsOf(turns.value);

        // An analysis with no SQLite row has no name, and no `{A}` route opens it, thus its items drop.
        const activityOf = threadActivityOf(pending, runningTurns);
        const body: Attention = {
            asks: pending.flatMap((ask): AttentionAsk[] => {
                const analysisName = names.value.get(ask.analysisId);
                if (analysisName === undefined) return [];
                return [
                    {
                        askId: ask.id,
                        analysisId: ask.analysisId,
                        analysisName,
                        threadId: ask.threadId,
                        title: ask.title,
                        command: ask.command,
                        createdAt: ask.createdAt,
                        stale: ask.threadId === null || !runningTurns.has(ask.threadId),
                    },
                ];
            }),
            activeRuns: running.flatMap((entry): AttentionActiveRun[] => {
                const analysisName = names.value.get(entry.analysisId);
                if (analysisName === undefined) return [];
                return [
                    {
                        runId: entry.runId,
                        analysisId: entry.analysisId,
                        analysisName,
                        threadId: entry.threadId,
                        planTitle: entry.planTitle,
                        doneSteps: entry.doneSteps,
                        totalSteps: entry.totalSteps,
                        startedAt: entry.startedAt,
                    },
                ];
            }),
            unseenRuns: unseen.flatMap((entry): AttentionUnseenRun[] => {
                const analysisName = names.value.get(entry.analysisId);
                if (analysisName === undefined) return [];
                return [{ runId: entry.runId, analysisId: entry.analysisId, analysisName, status: entry.status, completedAt: entry.completedAt }];
            }),
            recentThreads: recent.flatMap((thread): AttentionThread[] => {
                const analysisName = names.value.get(thread.analysisId);
                if (analysisName === undefined) return [];
                return [{ ...toThreadSummary(thread, activityOf(thread.threadId)), analysisName }];
            }),
        };
        return c.json<Attention>(body);
    });

    return routes;
}

/** The `since` of the seen baseline as a `toISOString()` form, or `null` when the baseline row is absent or is not a time. */
function seenSinceOf(since: number | null): string | null {
    if (since === null) return null;
    const date = new Date(since);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
