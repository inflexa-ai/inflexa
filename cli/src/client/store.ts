import type { ResultAsync } from "neverthrow";

import type { FarmLinkRequest, FarmLinkView, StartTransferRequest, StartTransfersResponse, StoreAddAccepted, StoreState } from "../api/store.ts";
import { DEFAULT_CLIENT_OPTS, request, type ClientError, type ClientOpts } from "./api.ts";

/** `GET /api/v1/store`: the three transfers, the flights, and the adds that wait. */
export function fetchStore(opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<StoreState, ClientError> {
    return request<StoreState>("GET", "/api/v1/store", {}, opts);
}

/** `POST /api/v1/store/transfers`: start an image or a catalog transfer, as a detached child of the server. */
export function createTransfer(body: StartTransferRequest, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<StartTransfersResponse, ClientError> {
    return request<StartTransfersResponse>("POST", "/api/v1/store/transfers", { body }, opts);
}

/** `POST /api/v1/store/flights/:flightId/retry`: enqueue a failed flight again and start the flush. */
export function retryStoreFlight(flightId: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<StoreAddAccepted, ClientError> {
    return request<StoreAddAccepted>("POST", `/api/v1/store/flights/${encodeURIComponent(flightId)}/retry`, {}, opts);
}

/** `DELETE /api/v1/store/flights/:flightId`: remove a failed flight record. */
export function deleteStoreFlight(flightId: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<{ deleted: true }, ClientError> {
    return request<{ deleted: true }>("DELETE", `/api/v1/store/flights/${encodeURIComponent(flightId)}`, {}, opts);
}

/** `POST {A}/farm/link`: link packages that the pool holds into the farm of the analysis. */
export function createFarmLink(analysisId: string, body: FarmLinkRequest, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<FarmLinkView, ClientError> {
    return request<FarmLinkView>("POST", `/api/v1/analyses/${encodeURIComponent(analysisId)}/farm/link`, { body }, opts);
}
