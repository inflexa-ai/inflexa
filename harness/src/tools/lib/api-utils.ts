/**
 * Shared HTTP fetch helper for bioinformatics API tools.
 *
 * Provides retry-with-backoff for rate-limited APIs (429/503), request
 * timeouts, and tab-delimited text parsing. `apiFetch` is the external-call
 * boundary, so it is where a throw becomes a `Result`: it returns a
 * `ResultAsync<T, ApiError>` rather than throwing — callers branch on
 * `isErr()` and read `value` / `error` (see `result.ts` for the house rules).
 */

import { ResultAsync, err, ok, type Result } from "neverthrow";
import { z } from "zod";

import { sleep } from "../../lib/async-utils.js";

export interface ApiFetchOptions {
    method?: "GET" | "POST";
    headers?: Record<string, string>;
    body?: string;
    maxRetries?: number;
    retryDelayMs?: number;
    timeoutMs?: number;
    parseAs?: "json" | "text";
}

/** The error channel of `apiFetch`. A `DomainError` (string `type` discriminant). */
export type ApiError =
    | { readonly type: "http_status"; readonly status: number; readonly body: string }
    | { readonly type: "timeout"; readonly timeoutMs: number }
    | { readonly type: "exhausted"; readonly attempts: number; readonly lastError: string }
    | { readonly type: "invalid_response"; readonly issues: string };

const RETRYABLE_STATUSES = new Set([429, 503]);

/**
 * Fetch a URL with retry on 429/503, exponential backoff, and timeout.
 * `err` carries the structured failure; a non-ok HTTP status is reported as
 * `http_status` so callers can branch on a concrete code (a 404 is usually an
 * expected "not found" → a data variant; see `isUnexpectedApiError`).
 */
export function apiFetch<T = unknown>(url: string, options: ApiFetchOptions = {}): ResultAsync<T, ApiError> {
    return new ResultAsync(runFetch<T>(url, options));
}

/**
 * `apiFetch` that validates the JSON response against a Zod `schema` before
 * returning it. The success value is the schema's parsed output, so callers
 * receive a payload whose shape has been checked rather than an unchecked
 * `apiFetch<T>` cast that trusts the wire.
 *
 * A response the schema rejects — the upstream API changed its contract, or
 * returned an error envelope where data was expected — resolves to an
 * `invalid_response` err. That is deliberately an *unexpected* `ApiError`
 * (`isUnexpectedApiError` returns true for it): a contract break should
 * surface, not silently become empty/garbage results downstream. To keep a
 * tool's graceful degradation, model genuinely-optional fields as
 * `.optional()`/`.nullable()` in the schema so a partial-but-valid response
 * still parses; reserve rejection for real type/shape drift.
 *
 * JSON only — `parseAs` is forced to `"json"`, since a schema over raw text is
 * just `z.string()`, which `apiFetch<string>` already covers.
 */
export function apiFetchValidated<S extends z.ZodType>(
    url: string,
    schema: S,
    options: Omit<ApiFetchOptions, "parseAs"> = {},
): ResultAsync<z.infer<S>, ApiError> {
    return apiFetch<unknown>(url, { ...options, parseAs: "json" }).andThen((data): Result<z.infer<S>, ApiError> => {
        const parsed = schema.safeParse(data);
        if (parsed.success) return ok(parsed.data);
        return err({ type: "invalid_response", issues: summarizeZodIssues(parsed.error) });
    });
}

/** Compact one-line rendering of a Zod validation failure (first few issues). */
function summarizeZodIssues(error: z.ZodError): string {
    const issues = error.issues.slice(0, 5).map((issue) => {
        const path = issue.path.map((segment) => String(segment)).join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
    });
    const remaining = error.issues.length - issues.length;
    return remaining > 0 ? `${issues.join("; ")} (+${remaining} more)` : issues.join("; ");
}

async function runFetch<T>(url: string, options: ApiFetchOptions): Promise<Result<T, ApiError>> {
    const { method = "GET", headers = {}, body, maxRetries = 3, retryDelayMs = 1000, timeoutMs = 90_000, parseAs = "json" } = options;

    let lastError = "";

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const res = await fetch(url, {
                method,
                headers,
                body,
                signal: AbortSignal.timeout(timeoutMs),
            });

            if (RETRYABLE_STATUSES.has(res.status) && attempt < maxRetries) {
                await sleep(retryDelayMs * 2 ** attempt);
                lastError = `HTTP ${res.status}`;
                continue;
            }

            if (!res.ok) {
                const text = await res.text().catch(() => "");
                return err({ type: "http_status", status: res.status, body: text.trim() });
            }

            const data = parseAs === "text" ? ((await res.text()) as T) : ((await res.json()) as T);
            return ok(data);
        } catch (e) {
            if (e instanceof DOMException && e.name === "TimeoutError") {
                return err({ type: "timeout", timeoutMs });
            }
            lastError = e instanceof Error ? e.message : String(e);
            if (attempt < maxRetries) {
                await sleep(retryDelayMs * 2 ** attempt);
                continue;
            }
        }
    }

    return err({ type: "exhausted", attempts: maxRetries + 1, lastError });
}

/** Render an `ApiError` as a one-line message (for a rethrow or log). */
export function describeApiError(e: ApiError): string {
    switch (e.type) {
        case "http_status":
            return e.body ? `HTTP ${e.status}: ${e.body}` : `HTTP ${e.status}`;
        case "timeout":
            return `Request timed out after ${e.timeoutMs}ms`;
        case "exhausted":
            return `Failed after ${e.attempts} attempts: ${e.lastError}`;
        case "invalid_response":
            return `Response did not match the expected schema: ${e.issues}`;
    }
}

/**
 * Is an `ApiError` an unexpected failure?
 *
 * A concrete 4xx means the request itself was wrong — a bad identifier, a
 * resource that does not exist — an expected outcome the caller models as
 * data (an empty result, a `notFound` entry). Everything else — 5xx, a
 * timeout, retry exhaustion, a transport failure, or a schema mismatch
 * (`invalid_response`) — is unexpected and the caller should surface it by
 * throwing (or returning `err`).
 */
export function isUnexpectedApiError(e: ApiError): boolean {
    return !(e.type === "http_status" && e.status >= 400 && e.status < 500);
}

/**
 * Parse tab-separated text into rows of columns (e.g., KEGG responses).
 * Filters out empty lines.
 */
export function parseTSV(text: string): string[][] {
    return text
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => line.split("\t"));
}
