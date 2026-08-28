/**
 * Shared HTTP fetch helper for bioinformatics API tools.
 *
 * Provides retry-with-backoff for a rate-limited or a transiently-broken API
 * (429/502/503/504), request
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

// 502 and 504 sit here next to 429 and 503 because a gateway in front of a bio
// provider answers with one of them while the origin restarts, and it sends an
// HTML body. That answer is transient, thus a retry gets the real payload.
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

/**
 * Fetch a URL with retry on 429/502/503/504, exponential backoff, and timeout.
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
 * Read a number that a provider serializes as a JSON string.
 *
 * A Tastypie `decimal` field (ChEMBL `max_phase`, `standard_value`,
 * `pchembl_value`) and the eutils `esearch` counts arrive as strings, and the
 * same value arrives as a number from a different serializer of the same
 * provider. One helper answers for both encodings, thus no call site invents its
 * own rule.
 *
 * A value that is not a finite number gives `null`. As a result a caller never
 * sees `NaN`, which compares false against itself and poisons every downstream
 * threshold.
 */
export function parseWireNumber(value: string | number | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    const trimmed = value.trim();
    // `Number("")` and `Number(" ")` give 0, thus an empty string must not reach it.
    if (trimmed === "") return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The schema form of `parseWireNumber`, for a field that a provider serializes
 * as a string or as a number.
 *
 * The helper accepts neither `null` nor an omission, because absence is a
 * per-provider policy and no field is widened without evidence. A caller
 * composes `.nullable()`, `.optional()`, or both, per the policy of its
 * provider.
 */
export const zWireNumber = z.union([z.string(), z.number()]).transform((value) => parseWireNumber(value));

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
