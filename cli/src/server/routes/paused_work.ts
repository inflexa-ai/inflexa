import { Hono, type Context } from "hono";
import { ResultAsync, type Result } from "neverthrow";
import type { ChatTurnSession, Work, WorkHold, WorkResume } from "@inflexa-ai/harness";

import type { HeldWork, PausedWork, PausedWorkList, ResumedWork } from "../../api/paused_work.ts";
import type { DbError } from "../../db/errors.ts";
import { listAnalysisNames } from "../../db/primary_query.ts";
import { noteAnalysisActivity } from "../../modules/analysis/activity.ts";
import { resolveModelConnection, type ModelConnectionIdentity } from "../../modules/harness/config.ts";
import { buildChatSession } from "../../modules/harness/turn.ts";
import type { ServerBoot } from "../boot.ts";
import { apiError, internalError, listEnvelope, parsePage, requireRuntime, type ServerEnv } from "../http.ts";
import { credentialRemedy } from "./conversation.ts";

/** What the paused-work routes are built from. Tests replace each one, because no cli test reaches Postgres. */
export type PausedWorkRouteOpts = {
    /** The model connection, for the remedy of the cause `credential`. Real: `resolveModelConnection`. */
    readonly connection: () => ModelConnectionIdentity;
    /**
     * The session of a resume. For a turn, the harness puts its credential for the turn. Real: the session of a
     * chat turn of the analysis, with no thread.
     */
    readonly session: (analysisId: string) => ChatTurnSession;
    /** The name of each analysis of the list that has a SQLite row. Real: `listAnalysisNames`. */
    readonly analysisNames: (ids: readonly string[]) => Result<Map<string, string>, DbError>;
};

/** The production {@link PausedWorkRouteOpts}. */
export const DEFAULT_PAUSED_WORK_ROUTE_OPTS: PausedWorkRouteOpts = {
    connection: resolveModelConnection,
    session: (analysisId) => buildChatSession(analysisId),
    analysisNames: listAnalysisNames,
};

/**
 * The routes under `{A}/paused-work`: the list of the paused work of the analysis, and the resume and the hold of one
 * work. Each reads the runtime. The stop of paused work has no route here: the abort of a turn and the cancel of a
 * run stop it.
 */
export function pausedWorkRoutes(boot: ServerBoot, opts: PausedWorkRouteOpts = DEFAULT_PAUSED_WORK_ROUTE_OPTS): Hono<ServerEnv> {
    const routes = new Hono<ServerEnv>();
    const runtime = requireRuntime(boot);

    routes.get("/", runtime, (c) => listPausedWork(c, opts, c.req.param("analysisId") ?? ""));

    routes.post("/:workId/resume", runtime, async (c) => {
        const analysisId = c.req.param("analysisId") ?? "";
        const workId = c.req.param("workId");
        const resumed = await ResultAsync.fromPromise(c.get("runtime").work.resume(opts.session(analysisId), workId), (cause) => cause);
        return resumed.match(
            (outcome: WorkResume) => {
                switch (outcome.kind) {
                    case "resumed":
                        noteAnalysisActivity(analysisId, Date.now());
                        return c.json<ResumedWork>({ workId, workflows: outcome.workflows });
                    case "not_found":
                        return apiError(c, "not_found", "No paused work of this analysis has this id. It can have resumed or stopped already.");
                    case "refused":
                        return apiError(c, "forbidden", `The work stays paused: ${outcome.reason}`);
                    default: {
                        const exhaustive: never = outcome;
                        throw new Error(`unhandled resume outcome: ${JSON.stringify(exhaustive)}`);
                    }
                }
            },
            (cause) => internalError(c, cause, "resume paused work"),
        );
    });

    routes.post("/:workId/hold", runtime, async (c) => {
        const analysisId = c.req.param("analysisId") ?? "";
        const workId = c.req.param("workId");
        const held = await ResultAsync.fromPromise(c.get("runtime").work.hold(opts.session(analysisId), workId), (cause) => cause);
        return held.match(
            (outcome: WorkHold) => {
                switch (outcome.kind) {
                    case "held":
                        return c.json<HeldWork>({ workId, workflows: outcome.workflows });
                    case "not_found":
                        return apiError(c, "not_found", "No paused work of this analysis has this id. It can have resumed or stopped already.");
                    default: {
                        const exhaustive: never = outcome;
                        throw new Error(`unhandled hold outcome: ${JSON.stringify(exhaustive)}`);
                    }
                }
            },
            (cause) => internalError(c, cause, "hold paused work"),
        );
    });

    return routes;
}

/**
 * The paused work of each analysis (`GET /api/v1/paused-work`), in the item shape of `GET {A}/paused-work`. It reads
 * the runtime, thus it waits for the boot. It is outside `/api/v1/analyses/:analysisId`, thus the analysis guard
 * does not cover it.
 */
export function pausedWorkCollectionRoutes(boot: ServerBoot, opts: PausedWorkRouteOpts = DEFAULT_PAUSED_WORK_ROUTE_OPTS): Hono<ServerEnv> {
    const routes = new Hono<ServerEnv>();
    routes.get("/", requireRuntime(boot), (c) => listPausedWork(c, opts, undefined));
    return routes;
}

/**
 * The page of the paused work of one analysis, or of each analysis when `analysisId` is absent. It calls `work.list`
 * one time. The runtime lists each active work, and this gives the work that waits. The work of an analysis with no
 * SQLite row drops before the page, thus `total` counts only the items that a client gets: no `{A}` route can act on
 * that work.
 */
async function listPausedWork(c: Context<ServerEnv>, opts: PausedWorkRouteOpts, analysisId: string | undefined): Promise<Response> {
    const page = parsePage(c.req.query("page"), c.req.query("perPage"));
    const listed = await ResultAsync.fromPromise(c.get("runtime").work.list(analysisId), (cause) => cause);
    if (listed.isErr()) return internalError(c, listed.error, "list the paused work");

    let waiting = listed.value.filter((work) => work.waiting.length > 0);
    if (analysisId === undefined) {
        const names = opts.analysisNames(waiting.map((work) => work.analysisId));
        if (names.isErr()) return internalError(c, names.error, "read the analysis names");
        waiting = waiting.filter((work) => names.value.has(work.analysisId));
    }

    // The connection is read one time, and only when an item needs the remedy.
    let remedy: string | undefined;
    const remedyOf = (): string => (remedy ??= credentialRemedy(opts.connection()).message);
    const items = waiting.map((work) => withRemedy(work, remedyOf));
    const start = page.page * page.perPage;
    return c.json<PausedWorkList>(listEnvelope("pausedWork", items.slice(start, start + page.perPage), items.length, page));
}

/** The work on the wire: the remedy rides an item that a waiting workflow with the cause `credential` holds. */
function withRemedy(work: Work, remedyOf: () => string): PausedWork {
    return work.waiting.some((waiting) => waiting.cause.kind === "credential") ? { ...work, remedy: remedyOf() } : work;
}
