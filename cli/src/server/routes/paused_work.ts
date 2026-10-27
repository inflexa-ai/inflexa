import { Hono } from "hono";
import { ResultAsync } from "neverthrow";
import type { ChatTurnSession, PausedWork as HarnessPausedWork, PausedWorkResume } from "@inflexa-ai/harness";

import type { PausedWork, PausedWorkList, ResumedWork } from "../../api/paused_work.ts";
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
};

/** The production {@link PausedWorkRouteOpts}. */
export const DEFAULT_PAUSED_WORK_ROUTE_OPTS: PausedWorkRouteOpts = {
    connection: resolveModelConnection,
    session: (analysisId) => buildChatSession(analysisId),
};

/**
 * The routes under `{A}/paused-work`: the list of the paused work of the analysis, and the resume of one work. Both
 * read the runtime. The stop of paused work has no route here: the abort of a turn and the cancel of a run stop it.
 */
export function pausedWorkRoutes(boot: ServerBoot, opts: PausedWorkRouteOpts = DEFAULT_PAUSED_WORK_ROUTE_OPTS): Hono<ServerEnv> {
    const routes = new Hono<ServerEnv>();
    const runtime = requireRuntime(boot);

    routes.get("/", runtime, async (c) => {
        const analysisId = c.req.param("analysisId") ?? "";
        const page = parsePage(c.req.query("page"), c.req.query("perPage"));
        const listed = await ResultAsync.fromPromise(c.get("runtime").pausedWork.list(analysisId), (cause) => cause);
        return listed.match(
            (works) => {
                // The connection is read one time, and only when an item needs the remedy.
                let remedy: string | undefined;
                const remedyOf = (): string => (remedy ??= credentialRemedy(opts.connection()).message);
                const items = works.map((work) => withRemedy(work, remedyOf));
                const start = page.page * page.perPage;
                return c.json<PausedWorkList>(listEnvelope("pausedWork", items.slice(start, start + page.perPage), items.length, page));
            },
            (cause) => internalError(c, cause, "list the paused work"),
        );
    });

    routes.post("/:workId/resume", runtime, async (c) => {
        const analysisId = c.req.param("analysisId") ?? "";
        const workId = c.req.param("workId");
        const resumed = await ResultAsync.fromPromise(c.get("runtime").pausedWork.resume(opts.session(analysisId), workId), (cause) => cause);
        return resumed.match(
            (outcome: PausedWorkResume) => {
                switch (outcome.kind) {
                    case "resumed":
                        noteAnalysisActivity(analysisId, Date.now());
                        return c.json<ResumedWork>({ workId, workflows: outcome.workflows });
                    case "not_found":
                        return apiError(c, "not_found", "No paused work of this analysis has this id. It can have resumed or stopped already.");
                    default: {
                        const exhaustive: never = outcome;
                        throw new Error(`unhandled resume outcome: ${JSON.stringify(exhaustive)}`);
                    }
                }
            },
            (cause) => internalError(c, cause, "resume paused work"),
        );
    });

    return routes;
}

/** The work on the wire: the remedy rides an item that a waiting workflow with the cause `credential` holds. */
function withRemedy(work: HarnessPausedWork, remedyOf: () => string): PausedWork {
    return work.waiting.some((waiting) => waiting.cause.kind === "credential") ? { ...work, remedy: remedyOf() } : work;
}
