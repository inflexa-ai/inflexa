import type { MiddlewareHandler } from "hono";

import { getAnalysis } from "../db/primary_query.ts";
import { acquireInstanceLock, holdsInstanceLock, type LockOutcome } from "../lib/lock.ts";
import { apiError, internalError, type ServerEnv } from "./http.ts";

/** The instance lock of {@link analysisGuard}. Tests replace it. */
export type AnalysisGuardOpts = {
    readonly acquireLock: (analysisId: string) => LockOutcome;
};

/** The production {@link AnalysisGuardOpts}: the per-analysis instance lock of `lib/lock.ts`. */
export const DEFAULT_ANALYSIS_GUARD_OPTS: AnalysisGuardOpts = {
    acquireLock: (analysisId) => (holdsInstanceLock(analysisId) ? { acquired: true } : acquireInstanceLock(analysisId)),
};

/**
 * The middleware of each route under `/api/v1/analyses/:analysisId`: 404 `not_found` when no analysis has
 * the id, then the instance lock of the analysis, 409 `locked` when a different live process holds it.
 *
 * The lock keeps one provenance recorder on each signed chain across processes. The server takes it at the
 * first request for an analysis and holds it until the process exits, as a fence against an installed
 * binary from before the server, which shares the database and the lock folder and writes the chain of an
 * `inputs add` directly. The in-process input tool of a chat asserts the same lock.
 *
 * Mount it AFTER the routes of `/api/v1/analyses` that have no analysis id (`resolve`): a handler that
 * answers before the guard in the registration order ends the chain, and the guard pattern also matches
 * `/api/v1/analyses/resolve`. Mount each `{A}` route after it, or the route answers before the guard runs.
 */
export function analysisGuard(opts: AnalysisGuardOpts = DEFAULT_ANALYSIS_GUARD_OPTS): MiddlewareHandler<ServerEnv> {
    return async (c, next) => {
        const analysisId = c.req.param("analysisId") ?? "";
        const found = getAnalysis(analysisId);
        if (found.isErr()) return internalError(c, found.error, "read the analysis");
        if (found.value === null) return apiError(c, "not_found", `No analysis has the id ${analysisId}.`);

        const lock = opts.acquireLock(analysisId);
        if (!lock.acquired) {
            // `acquireInstanceLock` reports an unknown holder as -1 on the reclaim race: the pid clause then reads as a bug.
            const pidClause = lock.holderPid >= 0 ? ` (pid ${lock.holderPid})` : "";
            return apiError(c, "locked", `"${found.value.name}" is already open in another instance${pidClause}. Close it there, then try again.`, {
                holderPid: lock.holderPid,
            });
        }
        await next();
    };
}
