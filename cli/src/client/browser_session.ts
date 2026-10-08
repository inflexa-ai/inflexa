import type { ResultAsync } from "neverthrow";

import type { SessionNonce } from "../api/browser_session.ts";
import { DEFAULT_CLIENT_OPTS, request, type ClientError, type ClientOpts } from "./api.ts";

/** `POST /api/v1/session/nonce`: a one-time nonce that signs a browser in. Only the bearer token gets one. */
export function requestSessionNonce(opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<SessionNonce, ClientError> {
    return request<SessionNonce>("POST", "/api/v1/session/nonce", {}, opts);
}
