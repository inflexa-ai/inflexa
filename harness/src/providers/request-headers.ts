/**
 * The model request headers hook.
 *
 * The hook is a gate (`lib/hooks.ts`): the provider calls it before each
 * attempt of a model request, and it adds the headers to the request as the
 * hook gives them. The harness reads no header and makes no header of its own.
 *
 * The hook is not the model wire, thus a refusal stops the call at once, with
 * no retry, and the refused attempt is never sent.
 */

import { okAsync, type ResultAsync } from "neverthrow";

import type { ResolvableSession } from "../auth/types.js";
import { passGate, type GateFailure, type GateRefusal } from "../lib/hooks.js";
import type { ProviderError } from "./errors.js";

export type RequestHeaders = Readonly<Record<string, string>>;

export type ResolveRequestHeaders = (session: ResolvableSession) => ResultAsync<RequestHeaders, GateFailure>;

const NO_HEADERS: RequestHeaders = {};

export function requestHeadersFor(hook: ResolveRequestHeaders | undefined, session: ResolvableSession): ResultAsync<RequestHeaders, GateRefusal> {
    return hook === undefined ? okAsync(NO_HEADERS) : passGate("resolveRequestHeaders", hook(session));
}

export function headersRefusalError(refusal: GateRefusal, workload: string): ProviderError {
    const message = `The request headers hook refused the model call for ${workload}: ${refusal.reason}`;
    return refusal.kind === "suspended"
        ? { type: "suspend", retryable: false, reason: refusal.reason, message }
        : { type: "provider", retryable: false, message };
}
