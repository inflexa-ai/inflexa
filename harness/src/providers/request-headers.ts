/**
 * The model request headers hook.
 *
 * A host that attributes a model call gives `resolveRequestHeaders` to each
 * provider. The hook is a gate (`lib/hooks.ts`): the provider calls it before
 * each attempt of a model request, and it adds the headers to the request as
 * the hook gives them. The harness reads no header and makes no header of its
 * own. A provider with no hook adds no headers.
 *
 * The hook is not the model wire, thus a refusal stops the call at once, with
 * no retry, and the refused attempt is never sent.
 */

import { okAsync, type ResultAsync } from "neverthrow";

import type { ResolvableSession } from "../auth/types.js";
import { passGate, type GateFailure, type GateRefusal } from "../lib/hooks.js";
import type { ProviderError } from "./errors.js";

/** The headers that the host adds to a model request. */
export type RequestHeaders = Readonly<Record<string, string>>;

/** The model request headers hook of a provider. */
export type ResolveRequestHeaders = (session: ResolvableSession) => ResultAsync<RequestHeaders, GateFailure>;

const NO_HEADERS: RequestHeaders = {};

/** The headers of one attempt, or the refusal of the hook. An absent hook gives no headers. */
export function requestHeadersFor(hook: ResolveRequestHeaders | undefined, session: ResolvableSession): ResultAsync<RequestHeaders, GateRefusal> {
    return hook === undefined ? okAsync(NO_HEADERS) : passGate("resolveRequestHeaders", hook(session));
}

/**
 * The provider error of a call that the hook refused. It is never retryable.
 * A refusal with the suspend flag is a `suspend` error with no status.
 */
export function headersRefusalError(refusal: GateRefusal, workload: string): ProviderError {
    const message = `The request headers hook refused the model call for ${workload}: ${refusal.reason}`;
    return refusal.kind === "suspended"
        ? { type: "suspend", retryable: false, reason: refusal.reason, message }
        : { type: "provider", retryable: false, message };
}
