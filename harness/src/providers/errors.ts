/**
 * Provider error taxonomy.
 *
 * Callers (the agent loop, the chat route, DBOS steps) branch on error
 * origin: a billing-gateway governance rejection is permanent and user-facing; a
 * transient upstream hiccup is retryable. This module owns the
 * classification so callers do not re-derive it.
 *
 * The billing-gateway convention is status-code driven (no dedicated error header
 * is required to disambiguate): the gateway emits `402` exclusively for
 * `budget_exceeded` and `403` for a blocked tenant. Provider-originated
 * failures (429, 5xx, connection) surface with their own status or as a
 * network error with no status at all.
 */

export type ProviderErrorKind = "budget" | "tenant-blocked" | "provider";

/**
 * The provider error value channel — a `DomainError`-conforming
 * discriminated union mirroring `ProviderErrorKind`. `chat` / `embed` return
 * `err(ProviderError)` instead of throwing a typed Error; `toProviderError`
 * is the sole constructor. `cause` carries the original SDK throwable so the
 * cause-walking classifiers (`isBudgetExceeded`, `classifyProviderError`)
 * still reach the `status` / `code` signals after `toThrowable` rethrows at a
 * step boundary.
 */
export type ProviderError =
    | { readonly type: "budget"; readonly retryable: false; readonly message: string; readonly cause?: unknown }
    | { readonly type: "tenant-blocked"; readonly retryable: false; readonly message: string; readonly cause?: unknown }
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
    return (v.type === "budget" || v.type === "tenant-blocked" || v.type === "provider") && typeof v.retryable === "boolean" && typeof v.message === "string";
}

/**
 * Turn a caught SDK throwable into a `ProviderError` value. Routes through
 * `classifyProviderError` so the `provider` variant's `retryable` keeps the
 * transient (429 / 5xx / connection) classification. `cause` is the original
 * throwable verbatim — for the budget variant it MUST be the SDK error
 * carrying status 402, which is what `isBudgetExceeded` walks.
 *
 * Idempotent: `chatStream` throws a `ProviderError` value, which
 * `streaming-chat`'s `catch` re-wraps by calling this again. Returning an
 * already-constructed `ProviderError` unchanged stops that second pass from
 * `String()`-ing the object (a `ProviderError` is not an `Error`) into a
 * `"[object Object]"` message that would bury the real inner one.
 */
export function toProviderError(e: unknown, workload: string): ProviderError {
    if (isProviderError(e)) return e;
    const { kind, retryable } = classifyProviderError(e);
    const detail = e instanceof Error ? e.message : String(e);
    if (kind === "budget") {
        return {
            type: "budget",
            retryable: false,
            message: `Billing budget exceeded for ${workload}: ${detail}`,
            cause: e,
        };
    }
    if (kind === "tenant-blocked") {
        return {
            type: "tenant-blocked",
            retryable: false,
            message: `Billing gateway blocked tenant for ${workload}: ${detail}`,
            cause: e,
        };
    }
    return { type: "provider", retryable, message: detail, cause: e };
}

export interface ProviderErrorClassification {
    readonly kind: ProviderErrorKind;
    /**
     * Whether re-issuing the same call could plausibly succeed. The Anthropic
     * SDK already retries transient failures internally; a `retryable: true`
     * classification on an error that still reached here tells the caller the
     * failure is transient in nature, not that a retry is mandatory.
     */
    readonly retryable: boolean;
}

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
    cause?: unknown;
}

/** Walk the `cause` chain for the first numeric HTTP status. */
function extractStatus(err: unknown): number | undefined {
    let cursor: unknown = err;
    for (let i = 0; i < MAX_CAUSE_HOPS && cursor; i++) {
        const e = cursor as MaybeErrorChain;
        if (typeof e.status === "number") return e.status;
        if (typeof e.statusCode === "number") return e.statusCode;
        cursor = e.cause;
    }
    return undefined;
}

/** Does any link of the `cause` chain look like a transport-level failure? */
function looksLikeConnectionError(err: unknown): boolean {
    let cursor: unknown = err;
    for (let i = 0; i < MAX_CAUSE_HOPS && cursor; i++) {
        const e = cursor as MaybeErrorChain;
        if (typeof e.code === "string" && CONNECTION_ERROR_CODES.has(e.code)) {
            return true;
        }
        if (typeof e.name === "string" && /^APIConnection/.test(e.name)) {
            return true;
        }
        if (typeof e.message === "string" && CONNECTION_ERROR_PATTERN.test(e.message)) {
            return true;
        }
        cursor = e.cause;
    }
    return false;
}

/**
 * Classify a provider failure by origin.
 *
 * - Billing-gateway `402` → `budget`, not retryable.
 * - Billing-gateway `403` → `tenant-blocked`, not retryable.
 * - Provider `429` / `5xx` / connection errors → `provider`, retryable.
 * - Other `4xx` and parse / unknown errors → `provider`, not retryable.
 */
export function classifyProviderError(e: unknown): ProviderErrorClassification {
    const status = extractStatus(e);

    if (status === 402) return { kind: "budget", retryable: false };
    if (status === 403) return { kind: "tenant-blocked", retryable: false };
    if (status === 429 || (status !== undefined && status >= 500)) {
        return { kind: "provider", retryable: true };
    }
    if (status !== undefined) {
        // A concrete 4xx (other than 402/403) — the request is wrong; retrying
        // it unchanged will fail again.
        return { kind: "provider", retryable: false };
    }
    // No status: a transport failure is retryable; anything else (parse
    // errors, unexpected throws) is not.
    return {
        kind: "provider",
        retryable: looksLikeConnectionError(e),
    };
}
