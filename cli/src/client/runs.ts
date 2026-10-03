import type { Result, ResultAsync } from "neverthrow";
import type { ChatPart } from "@inflexa-ai/harness/contracts/index.js";

import type { CancelRunResult, ChatContext, DataProfileView, FarmHealResult, ProfileRerunResult, RunDetail, RunList, SandboxReadiness } from "../api/runs.ts";
import { DEFAULT_CLIENT_OPTS, request, streamRequest, type ClientError, type ClientOpts } from "./api.ts";

/** The query of `GET {A}/runs`. Each field is optional: the server pages with its defaults. */
export type RunListQuery = {
    page?: number;
    perPage?: number;
    /** Only the runs that are not terminal. */
    active?: boolean;
    /** Only the runs that the turns of this thread launched. */
    threadId?: string;
};

function analysisPath(analysisId: string): string {
    return `/api/v1/analyses/${encodeURIComponent(analysisId)}`;
}

/** `GET {A}/runs`: one page of the runs of the analysis, newest first, each with its plan title and its usage. */
export function fetchRuns(analysisId: string, query: RunListQuery = {}, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<RunList, ClientError> {
    const params = new URLSearchParams();
    if (query.page !== undefined) params.set("page", String(query.page));
    if (query.perPage !== undefined) params.set("perPage", String(query.perPage));
    if (query.active === true) params.set("active", "true");
    if (query.threadId !== undefined) params.set("threadId", query.threadId);
    const search = params.size === 0 ? "" : `?${params.toString()}`;
    return request<RunList>("GET", `${analysisPath(analysisId)}/runs${search}`, {}, opts);
}

/** `GET {A}/run/:runId`: one run with its steps and the usage of each step. 404 `not_found` for a run of a different analysis. */
export function fetchRun(analysisId: string, runId: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<RunDetail, ClientError> {
    return request<RunDetail>("GET", `${analysisPath(analysisId)}/run/${encodeURIComponent(runId)}`, {}, opts);
}

/**
 * `GET {A}/run/:runId/stream`: the parts of the run and of its children, from the start, until the run is
 * terminal. A canceled run ends with a `data-run-failed` part with `reason: "canceled"`. The id can also be
 * the workflow id of the data profile. Aborting `signal` closes the stream.
 */
export function streamRun(
    analysisId: string,
    runId: string,
    signal: AbortSignal,
    opts: ClientOpts = DEFAULT_CLIENT_OPTS,
): ResultAsync<AsyncGenerator<Result<ChatPart, ClientError>>, ClientError> {
    return streamRequest<ChatPart>("GET", `${analysisPath(analysisId)}/run/${encodeURIComponent(runId)}/stream`, { signal }, opts);
}

/** `POST {A}/run/:runId/cancel`: cancel the run and its children. 404 `not_found` for a run of a different analysis. */
export function cancelRun(analysisId: string, runId: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<CancelRunResult, ClientError> {
    return request<CancelRunResult>("POST", `${analysisPath(analysisId)}/run/${encodeURIComponent(runId)}/cancel`, {}, opts);
}

/**
 * `GET {A}/chat-context`: run the profile parity drive of a chat open, then give the profile state and the
 * outcome of the drive. The response waits for the dispatch of a profile, not for its end.
 */
export function fetchChatContext(analysisId: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<ChatContext, ClientError> {
    return request<ChatContext>("GET", `${analysisPath(analysisId)}/chat-context`, {}, opts);
}

/** `GET {A}/data-profile`: the profile state, its workflow id, and its usage. A read only. */
export function fetchDataProfile(analysisId: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<DataProfileView, ClientError> {
    return request<DataProfileView>("GET", `${analysisPath(analysisId)}/data-profile`, {}, opts);
}

/** `POST {A}/data-profile/rerun`: profile the analysis again, on the request of the user. The response gives the outcome of the dispatch. */
export function rerunDataProfile(analysisId: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<ProfileRerunResult, ClientError> {
    return request<ProfileRerunResult>("POST", `${analysisPath(analysisId)}/data-profile/rerun`, {}, opts);
}

/** `GET {A}/sandbox-readiness`: the verdict of the machine for a sandbox of the analysis. It consumes a recorded farm failure. */
export function fetchSandboxReadiness(analysisId: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<SandboxReadiness, ClientError> {
    return request<SandboxReadiness>("GET", `${analysisPath(analysisId)}/sandbox-readiness`, {}, opts);
}

/** `POST {A}/farm/heal`: compose the missing package farm of the analysis from the catalog. */
export function healFarm(analysisId: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<FarmHealResult, ClientError> {
    return request<FarmHealResult>("POST", `${analysisPath(analysisId)}/farm/heal`, {}, opts);
}
