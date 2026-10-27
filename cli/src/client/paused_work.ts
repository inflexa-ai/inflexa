import type { ResultAsync } from "neverthrow";

import { MAX_PER_PAGE } from "../api/common.ts";
import type { HeldWork, PausedWorkList, ResumedWork } from "../api/paused_work.ts";
import { DEFAULT_CLIENT_OPTS, request, type ClientError, type ClientOpts } from "./api.ts";

function pausedWorkPath(analysisId: string): string {
    return `/api/v1/analyses/${encodeURIComponent(analysisId)}/paused-work`;
}

/**
 * `GET {A}/paused-work`: the paused work of an analysis, in one page of the largest size. The paused work of one
 * analysis is a few items: each item is a turn, a run, or the data profile that waits.
 */
export function fetchPausedWork(analysisId: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<PausedWorkList, ClientError> {
    const params = new URLSearchParams({ page: "0", perPage: String(MAX_PER_PAGE) });
    return request<PausedWorkList>("GET", `${pausedWorkPath(analysisId)}?${params.toString()}`, {}, opts);
}

/**
 * `POST {A}/paused-work/:workId/resume`: resume each waiting workflow of the work. A wait in `retrying` ends at
 * once, thus the same call is "retry now". 404 `not_found` when the analysis has no paused work with this id.
 */
export function resumePausedWork(analysisId: string, workId: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<ResumedWork, ClientError> {
    return request<ResumedWork>("POST", `${pausedWorkPath(analysisId)}/${encodeURIComponent(workId)}/resume`, {}, opts);
}

/**
 * `POST {A}/paused-work/:workId/hold`: move each wait of the work in `retrying` to `paused`, thus its timer stops and
 * the work waits for a resume. 404 `not_found` when the analysis has no paused work with this id.
 */
export function holdPausedWork(analysisId: string, workId: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<HeldWork, ClientError> {
    return request<HeldWork>("POST", `${pausedWorkPath(analysisId)}/${encodeURIComponent(workId)}/hold`, {}, opts);
}
