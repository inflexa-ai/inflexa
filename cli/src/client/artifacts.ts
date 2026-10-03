import type { ResultAsync } from "neverthrow";

import type { ResolveArtifactsRequest, ResolvedArtifacts } from "../api/artifacts.ts";
import { DEFAULT_CLIENT_OPTS, request, type ClientError, type ClientOpts } from "./api.ts";

/**
 * `POST {A}/artifacts/resolve`: the path on disk and the degraded mark of each entry of a card. With
 * `materialize`, the server writes each echart or svg file first, thus the client can open the path.
 */
export function resolveArtifacts(
    analysisId: string,
    body: ResolveArtifactsRequest,
    opts: ClientOpts = DEFAULT_CLIENT_OPTS,
): ResultAsync<ResolvedArtifacts, ClientError> {
    return request<ResolvedArtifacts>("POST", `/api/v1/analyses/${encodeURIComponent(analysisId)}/artifacts/resolve`, { body }, opts);
}
