import type { ResultAsync } from "neverthrow";

import type {
    PruneAnchorsRequest,
    PruneAnchorsResponse,
    RelocateAnchorRequest,
    RelocateAnchorResponse,
    RepairAnchorRequest,
    RepairAnchorResponse,
} from "../api/anchors.ts";
import { DEFAULT_CLIENT_OPTS, request, type ClientError, type ClientOpts } from "./api.ts";

/** `POST /api/v1/anchors/repair`: point the anchor of the marker at `path` back at that folder. */
export function repairAnchor(body: RepairAnchorRequest, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<RepairAnchorResponse, ClientError> {
    return request<RepairAnchorResponse>("POST", "/api/v1/anchors/repair", { body }, opts);
}

/** `POST /api/v1/anchors/relocate`: point a moved anchor, or each anchor under a moved tree, at its new path. */
export function relocateAnchor(body: RelocateAnchorRequest, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<RelocateAnchorResponse, ClientError> {
    return request<RelocateAnchorResponse>("POST", "/api/v1/anchors/relocate", { body }, opts);
}

/** `POST /api/v1/anchors/prune`: drop the anchors whose folders are gone, and purge their analyses. */
export function pruneAnchors(body: PruneAnchorsRequest, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<PruneAnchorsResponse, ClientError> {
    return request<PruneAnchorsResponse>("POST", "/api/v1/anchors/prune", { body }, opts);
}
