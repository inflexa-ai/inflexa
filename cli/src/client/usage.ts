import type { ResultAsync } from "neverthrow";

import type { UsageQuery, UsageView } from "../api/usage.ts";
import { DEFAULT_CLIENT_OPTS, request, type ClientError, type ClientOpts } from "./api.ts";

/**
 * `GET {A}/usage`: the recorded LLM usage of one scope of the analysis, with at most one grouping. 404
 * `not_found` for a `runId` that matches no run with recorded usage, 409 `conflict` for one that matches more
 * than one run.
 */
export function fetchUsage(analysisId: string, query: UsageQuery, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<UsageView, ClientError> {
    const params = new URLSearchParams();
    if (query.threadId !== undefined) params.set("threadId", query.threadId);
    if (query.runId !== undefined) params.set("runId", query.runId);
    if (query.by !== undefined) params.set("by", query.by);
    const search = params.size > 0 ? `?${params.toString()}` : "";
    return request<UsageView>("GET", `/api/v1/analyses/${encodeURIComponent(analysisId)}/usage${search}`, {}, opts);
}
