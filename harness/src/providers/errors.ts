/**
 * Provider error taxonomy.
 *
 * Callers (the agent loop, the chat route, DBOS steps) branch on error
 * origin: a status that the host maps to a suspension stops the work; a
 * transient upstream hiccup is retryable. This module owns the
 * classification so callers do not re-derive it.
 *
 * The classification keys on the HTTP status alone. The meaning of a status
 * belongs to the gateway of the host, thus each provider takes a map from a
 * status to a suspend reason (`suspendOn`). A status in the map is a `suspend`
 * error, before each other rule, and it is never retried. The harness carries
 * the reason and never reads it. Provider-originated failures (429, 5xx,
 * connection) surface with their own status or as a network error with no
 * status at all. A `401` is `auth`: the credential the host put behind the call
 * is expired, revoked, or absent, and only a human re-authenticating fixes it —
 * which is a different remedy from every other non-retryable 4xx, so it is a
 * different kind.
 */

import { redactSecrets } from "../input-sanitization.js";

/**
 * The sentinel that the request-timeout guard uses as an abort reason. The guard
 * arms a timer for each fetch attempt. On expiry the guard aborts the attempt
 * with this value. The value rides the abort chain, thus the classifier finds it
 * and marks the attempt as a retryable provider timeout.
 *
 * The name is not `AbortError`, thus the abort-detection paths do not swallow a
 * guard abort as a caller cancellation. The message names the configured value.
 */
export class RequestTimeoutError extends Error {
    /** The configured bound for one silent interval, in milliseconds. */
    readonly requestTimeoutMs: number;

    constructor(requestTimeoutMs: number) {
        super(`The provider sent no data within the request timeout of ${requestTimeoutMs} ms.`);
        this.name = "RequestTimeoutError";
        this.requestTimeoutMs = requestTimeoutMs;
    }
}

export type ProviderErrorKind = "auth" | "suspend" | "provider";

/**
 * A map from an HTTP status to the suspend reason of the host. A map from the
 * host replaces {@link DEFAULT_SUSPEND_ON}, and the two maps do not merge.
 */
export type SuspendOn = Readonly<Record<number, string>>;

/** The map of a provider that the host gives no map: `402` names a payment that the gateway requires. */
export const DEFAULT_SUSPEND_ON: SuspendOn = { 402: "payment_required" };

/**
 * The provider error value channel — a `DomainError`-conforming
 * discriminated union mirroring `ProviderErrorKind`. `chat` / `embed` return
 * `err(ProviderError)` instead of throwing a typed Error; `toProviderError`
 * is the sole constructor of a classified failure. `cause` carries the
 * original SDK throwable so the cause-walking classifier
 * (`classifyProviderError`) still reaches the `status` / `code` signals after
 * `toThrowable` rethrows at a step boundary.
 *
 * A `suspend` error carries the `reason` of the host. It carries no `status`
 * when the request headers hook refused the call with the suspend flag.
 */
export type ProviderError =
    | { readonly type: "auth"; readonly retryable: false; readonly message: string; readonly cause?: unknown }
    | {
          readonly type: "suspend";
          readonly retryable: false;
          readonly reason: string;
          readonly status?: number;
          readonly message: string;
          readonly cause?: unknown;
      }
    | { readonly type: "provider"; readonly retryable: boolean; readonly message: string; readonly cause?: unknown };

/**
 * Structural guard for an already-constructed `ProviderError` value. A
 * `ProviderError` is a plain object, not an `Error`, so it cannot be
 * recognized by `instanceof`; this checks the discriminant plus the two
 * always-present fields. Used by `toProviderError` to stay idempotent.
 */
export function isProviderError(value: unknown): value is ProviderError {
    if (typeof value !== "object" || value === null) return false;
    const v = value as { type?: unknown; retryable?: unknown; message?: unknown };
    return (v.type === "auth" || v.type === "suspend" || v.type === "provider") && typeof v.retryable === "boolean" && typeof v.message === "string";
}

export type SuspendError = Extract<ProviderError, { readonly type: "suspend" }>;

/**
 * Find a `suspend` error on a failure or on its `cause` chain. A step boundary
 * rethrows a `ProviderError` inside a `ResultError`, with the value on
 * `.cause`, thus the walk reaches it.
 *
 * A failed step that DBOS replays gives the error that DBOS recorded. That
 * record keeps only the enumerable fields of a `ResultError`: `.value` stays,
 * and the non-enumerable `.cause` does not. Thus the walk also reads `.value`.
 */
export function findSuspendError(err: unknown): SuspendError | undefined {
    const asSuspend = (value: unknown): SuspendError | undefined => (isProviderError(value) && value.type === "suspend" ? value : undefined);
    return findInCauseChain(
        err,
        (link) => asSuspend(link) ?? (typeof link === "object" && link !== null ? asSuspend((link as { value?: unknown }).value) : undefined),
    );
}

/**
 * Turn a caught SDK throwable into a `ProviderError` value. Routes through
 * `classifyProviderError` with the `suspendOn` map of the provider, so the
 * `provider` variant's `retryable` keeps the transient (429 / 5xx / connection)
 * classification and a mapped status becomes a `suspend` error. `cause` is the
 * original throwable verbatim.
 *
 * Idempotent: `chatStream` throws a `ProviderError` value, which
 * `streaming-chat`'s `catch` re-wraps by calling this again. Returning an
 * already-constructed `ProviderError` unchanged stops that second pass from
 * `String()`-ing the object (a `ProviderError` is not an `Error`) into a
 * `"[object Object]"` message that would bury the real inner one.
 */
export function toProviderError(e: unknown, workload: string, suspendOn: SuspendOn = DEFAULT_SUSPEND_ON): ProviderError {
    if (isProviderError(e)) return e;
    // A guard abort names the configured value in its message. Compose a message
    // that also names the workload, thus a reader sees both. This runs before the
    // status walk, because a guard abort carries no HTTP status. A timeout of the
    // SDK carries no sentinel, thus it falls to the composed arm below, which
    // forwards the message of the SDK.
    const timeout = findRequestTimeout(e);
    if (timeout !== undefined) {
        return {
            type: "provider",
            retryable: true,
            message: `The provider sent no data for ${workload} within the request timeout of ${timeout.requestTimeoutMs} ms.`,
            cause: e,
        };
    }
    const classified = classifyProviderError(e, suspendOn);
    const detail = e instanceof Error ? e.message : String(e);
    if (classified.kind === "auth") {
        return {
            type: "auth",
            retryable: false,
            message: `Provider rejected the credential for ${workload} — it is expired, revoked, or absent: ${detail}`,
            cause: e,
        };
    }
    // The `provider` and `suspend` arms compose one generic HTTP message rather
    // than forwarding the SDK message verbatim. A `suspend` message names no
    // cause of its own: the reason of the host rides beside it. The composition
    // has to happen: when a 4xx body does not parse against the configured
    // provider's error schema, the AI SDK falls back to
    // `response.statusText`, so the "detail" is a bare HTTP reason phrase —
    // `"Bad Request"` — that names neither the call nor the cause, while the
    // status, the workload, and the body the SDK captured are all still on the
    // `cause` chain right here.
    //
    // Composed strictly AFTER `classifyProviderError` has returned, so message
    // text can never become a classification input: the harness-providers spec
    // fixes classification on the HTTP status alone.
    const status = extractStatus(e);
    const lead = status === undefined ? `Provider call failed for ${workload}` : `Provider call failed for ${workload} (HTTP ${status})`;
    // A transport that carries no reason phrase (an HTTP/2 hop yields
    // `statusText === ""`) leaves `detail` empty; appending it regardless would
    // trail a bare `": "` on an otherwise complete message.
    const phrase = detail.trim();
    const diagnosed = phrase ? `${lead}: ${phrase}` : lead;
    const body = extractResponseBody(e);
    // The excerpt trails deliberately — workload and status lead, so a
    // downstream truncation (`profileFailureReason` cuts the line at 200)
    // eats the least diagnostic content first.
    const message = body ? `${diagnosed} — response body: ${excerptResponseBody(body)}` : diagnosed;
    if (classified.kind === "suspend") {
        return { type: "suspend", retryable: false, reason: classified.reason, status: classified.status, message, cause: e };
    }
    return { type: "provider", retryable: classified.retryable, message, cause: e };
}

/**
 * Max characters of a captured provider response body carried in a message.
 *
 * Derived, not picked: the tightest downstream consumer (`profileFailureReason`,
 * `tasks/data-profile.ts`) truncates the whole line at 200, and the lead this
 * excerpt trails — a workload label plus `HTTP <status>` plus a reason phrase —
 * runs to roughly 80. 120 is therefore the largest round value that cannot evict
 * that lead.
 *
 * Deliberately NOT shared with that consumer's `PROFILE_ERROR_MAX_LEN`: that one
 * bounds a `varchar` ledger column, this one bounds a message many non-ledger
 * consumers read, and coupling them would make either one unmovable.
 */
const PROVIDER_BODY_EXCERPT_MAX_LEN = 120;

/**
 * Single-lined, secret-redacted, length-capped rendering of a captured response body. Bounding happens
 * here rather than at a consumer because most `ProviderError` consumers truncate nothing at all, and the
 * one that does would let an unbounded body crowd out the workload and status ahead of it.
 *
 * The body is an UNTRUSTED upstream/proxy payload, and this excerpt lands verbatim in the ledger's
 * `data_profile_error` (surfaced to the UI) and the logs, whereas the composed lead does not — so
 * secrets are redacted here and nowhere else on the message. Redaction runs on the FULL body before
 * truncation: a token straddling the cut would otherwise be sliced into an unmatchable fragment that
 * leaks. `redactSecrets` matches only prefixed formats (API keys, JWTs, bearer tokens, connection
 * strings) and is safe on biological data, so a legitimate error body passes through intact.
 */
function excerptResponseBody(body: string): string {
    const singleLine = redactSecrets(body).replace(/\s+/g, " ").trim();
    // Slice by CODE POINT, not UTF-16 unit: a raw byte body can carry astral characters, and a plain
    // `.slice` could bisect a surrogate pair into a lone half that renders as U+FFFD.
    const chars = [...singleLine];
    return chars.length > PROVIDER_BODY_EXCERPT_MAX_LEN ? chars.slice(0, PROVIDER_BODY_EXCERPT_MAX_LEN - 1).join("") + "…" : singleLine;
}

/**
 * `retryable` says whether re-issuing the same call could plausibly succeed.
 * The Anthropic SDK already retries transient failures internally; a
 * `retryable: true` classification on an error that still reached here tells
 * the caller the failure is transient in nature, not that a retry is mandatory.
 */
export type ProviderErrorClassification =
    | { readonly kind: "suspend"; readonly retryable: false; readonly reason: string; readonly status: number }
    | { readonly kind: "auth"; readonly retryable: false }
    | { readonly kind: "provider"; readonly retryable: boolean };

/** Max links walked on the `cause` chain looking for a structured status. */
const MAX_CAUSE_HOPS = 5;

/** Node/undici error codes that mean "the connection itself failed". */
const CONNECTION_ERROR_CODES = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "ENOTFOUND",
    "ETIMEDOUT",
    "EPIPE",
    "EAI_AGAIN",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_SOCKET",
]);

const CONNECTION_ERROR_PATTERN =
    /fetch failed|socket hang up|network error|connection (?:refused|reset|error|closed)|econnrefused|enotfound|etimedout|terminated/i;

interface MaybeErrorChain {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    name?: unknown;
    message?: unknown;
    /** The AI SDK's `APICallError` carries the raw response body under this name. */
    responseBody?: unknown;
    cause?: unknown;
}

/**
 * Walk the `cause` chain up to {@link MAX_CAUSE_HOPS} links, and return the first
 * result that `probe` gives. `probe` gives a value for a link that matches, or
 * `undefined` for a link that does not. The walk stops at the first match, at
 * the hop cap, or at the end of the chain.
 */
function findInCauseChain<T>(err: unknown, probe: (link: unknown) => T | undefined): T | undefined {
    let cursor: unknown = err;
    for (let i = 0; i < MAX_CAUSE_HOPS && cursor; i++) {
        const found = probe(cursor);
        if (found !== undefined) return found;
        cursor = (cursor as MaybeErrorChain).cause;
    }
    return undefined;
}

/**
 * Walk the `cause` chain for the first numeric HTTP status. The single status
 * walker: `classifyProviderError` keys on what this returns, so a caller asking
 * "did the provider layer have a status to classify on?" must ask it here rather
 * than re-implement the traversal.
 */
export function extractStatus(err: unknown): number | undefined {
    return findInCauseChain(err, (link) => {
        const e = link as MaybeErrorChain;
        if (typeof e.status === "number") return e.status;
        if (typeof e.statusCode === "number") return e.statusCode;
        return undefined;
    });
}

/**
 * Walk the `cause` chain for the first captured provider response body.
 *
 * This is what recovers a proxy-minted or otherwise non-conforming error body:
 * the AI SDK keeps the raw bytes on `APICallError.responseBody` even when its
 * own parse against the provider's error schema fails and its `message` degrades
 * to the HTTP reason phrase. A blank body is treated as absent — an empty
 * `— response body:` segment says less than no segment at all.
 */
function extractResponseBody(err: unknown): string | undefined {
    let cursor: unknown = err;
    for (let i = 0; i < MAX_CAUSE_HOPS && cursor; i++) {
        const e = cursor as MaybeErrorChain;
        if (typeof e.responseBody === "string" && e.responseBody.trim() !== "") return e.responseBody;
        cursor = e.cause;
    }
    return undefined;
}

/**
 * Walk the `cause` chain for the request-timeout sentinel. The guard aborts a
 * fetch with a `RequestTimeoutError`. The SDK carries the abort reason down the
 * `cause` chain, thus the sentinel can sit one or more hops down.
 */
function findRequestTimeout(err: unknown): RequestTimeoutError | undefined {
    return findInCauseChain(err, (link) => {
        if (link instanceof RequestTimeoutError) return link;
        // A duplicate class identity across a realm boundary fails `instanceof`,
        // thus match the name and the field as a fallback.
        const e = link as MaybeErrorChain & { requestTimeoutMs?: unknown };
        if (e.name === "RequestTimeoutError" && typeof e.requestTimeoutMs === "number") return link as RequestTimeoutError;
        return undefined;
    });
}

/**
 * The name of the abort reason that the `timeout` setting of the SDK raises. The
 * SDK bounds each gap between two content chunks of a stream. On expiry it
 * aborts the call with a bare `DOMException` that has this name, no cause, and
 * no HTTP status. The message of that `DOMException` names the configured value.
 */
const SDK_TIMEOUT_ERROR_NAME = "TimeoutError";

/**
 * Walk the `cause` chain for the timeout that the SDK raises. The `DOMException`
 * carries no field of its own, thus the name is the one signal. The SDK carries
 * an abort reason down the `cause` chain, thus the reason can sit one or more
 * hops down.
 */
function findSdkTimeout(err: unknown): Error | undefined {
    return findInCauseChain(err, (link) => {
        const e = link as MaybeErrorChain;
        return e.name === SDK_TIMEOUT_ERROR_NAME ? (link as Error) : undefined;
    });
}

/** Does any link of the `cause` chain look like a transport-level failure? */
function looksLikeConnectionError(err: unknown): boolean {
    return (
        findInCauseChain(err, (link) => {
            const e = link as MaybeErrorChain;
            if (typeof e.code === "string" && CONNECTION_ERROR_CODES.has(e.code)) return true;
            if (typeof e.name === "string" && /^APIConnection/.test(e.name)) return true;
            if (typeof e.message === "string" && CONNECTION_ERROR_PATTERN.test(e.message)) return true;
            return undefined;
        }) ?? false
    );
}

/**
 * Classify a provider failure by origin.
 *
 * - A status in `suspendOn` → `suspend` with the reason of the map, not
 *   retryable. This rule comes before each other status rule.
 * - Provider `401` → `auth`, not retryable.
 * - Provider `429` / `5xx` / connection errors → `provider`, retryable.
 * - Other `4xx` and parse / unknown errors → `provider`, not retryable.
 */
export function classifyProviderError(e: unknown, suspendOn: SuspendOn = DEFAULT_SUSPEND_ON): ProviderErrorClassification {
    // The request-timeout guard aborts an attempt with a typed sentinel, and the
    // chunk bound of the SDK aborts one with a `TimeoutError`. Each classifies as
    // a retryable provider timeout, thus the envelope retries it under the same
    // policy as a connection error. This runs before the status and the
    // connection paths, because a timeout carries no HTTP status, and it must not
    // fall to a non-retryable path.
    if (findRequestTimeout(e) !== undefined || findSdkTimeout(e) !== undefined) return { kind: "provider", retryable: true };

    const status = extractStatus(e);

    if (status !== undefined && Object.hasOwn(suspendOn, status)) {
        return { kind: "suspend", retryable: false, reason: suspendOn[status]!, status };
    }

    // `auth` is its own kind rather than a plain non-retryable 4xx because the
    // remedy is categorically different: the request was well-formed and the
    // credential behind it is not, so no amount of re-issuing or rephrasing
    // helps — a human has to re-authenticate. Callers surface that; the generic
    // 4xx branch below would tell them the request was wrong, which is false.
    if (status === 401) return { kind: "auth", retryable: false };
    if (status === 429 || (status !== undefined && status >= 500)) {
        return { kind: "provider", retryable: true };
    }
    if (status !== undefined) {
        // A concrete 4xx that the map does not hold — the request is wrong;
        // retrying it unchanged will fail again.
        return { kind: "provider", retryable: false };
    }
    // No status: a transport failure is retryable; anything else (parse
    // errors, unexpected throws) is not.
    return {
        kind: "provider",
        retryable: looksLikeConnectionError(e),
    };
}
