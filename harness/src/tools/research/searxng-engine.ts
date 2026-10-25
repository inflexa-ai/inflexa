/**
 * The SearXNG realization of the `WebSearchEngine` capability.
 *
 * One SearXNG instance is the only engine the harness ships (the embedder owns
 * it and builds this realization at its composition root). The call rides
 * `apiFetchValidated` with a zod schema over the JSON envelope, and every
 * failure lands on the error side of the `Result` as the data-status variant the
 * tool reports — an HTTP error, a spent retryable status, a schema mismatch,
 * and a body that is not JSON are answers, not errors of the turn.
 */

import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

import { apiFetchValidated, type ApiError } from "../lib/api-utils.js";
import { isAllDigits, trimTrailingOf } from "../../lib/text.js";
import type { WebSearchAnswer, WebSearchEngine, WebSearchEngineError, WebSearchPage, WebSearchRequest, WebSearchResult } from "./web-search.js";

// SearXNG sends an explicit null for a snippet no engine produced, and it omits
// a key no engine filled, thus each field is optional and nullable alike. The
// fields an engine adds (`engine`, `score`, `publishedDate`, …) pass and strip.
const SearxngResultSchema = z.object({
    title: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    content: z.string().nullable().optional(),
});

// An answer is an object of a changing shape (`answer`, `url`, `template`,
// `engine`, …), thus the schema keeps it loose and the mapper reads the two
// fields the tool reports.
export const SearxngSearchResponseSchema = z.object({
    results: z.array(SearxngResultSchema).optional(),
    answers: z.array(z.looseObject({ answer: z.string().nullable().optional(), url: z.string().nullable().optional() })).optional(),
});

/** Map a parsed SearXNG envelope to the rows the tool reports. */
export function mapSearxngResponse(response: z.infer<typeof SearxngSearchResponseSchema>): WebSearchPage {
    const answers: WebSearchAnswer[] = [];
    for (const row of response.answers ?? []) {
        const answer = typeof row.answer === "string" ? row.answer : undefined;
        const url = typeof row.url === "string" ? row.url : undefined;
        if (answer === undefined && url === undefined) continue;
        answers.push({ answer, url });
    }

    const results: WebSearchResult[] = [];
    for (const row of response.results ?? []) {
        if (typeof row.url !== "string" || typeof row.title !== "string") continue;
        results.push({ title: row.title, url: row.url, snippet: typeof row.content === "string" ? row.content : undefined });
    }
    return { answers, results };
}

/**
 * Normalize the SearXNG base URL the embedder gives: `http`/`https` only, no
 * user name and no password, and no query, fragment, or trailing slash. The
 * value is a composition-root constant, thus a bad one throws here at wiring
 * time and not inside a tool call.
 */
export function normalizeSearxngBaseUrl(raw: string): string {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`The SearXNG base URL must use http or https: ${raw}`);
    }
    if (parsed.username !== "" || parsed.password !== "") {
        throw new Error(`The SearXNG base URL must carry no user name or password: ${raw}`);
    }
    return `${parsed.protocol}//${parsed.host}${trimTrailingOf(parsed.pathname, "/")}`;
}

/** The first 300 characters of a body, as the HTTP-error text reports it. */
function bodyExcerpt(body: string): string {
    return body.length > 300 ? body.slice(0, 300) : body;
}

/** Map one `ApiError` of the helper to the error data variant it names. */
export function describeSearchFailure(error: ApiError): WebSearchEngineError {
    switch (error.type) {
        case "http_status":
            return {
                status: "http_error",
                httpStatus: error.status,
                text: `SearXNG answered HTTP ${error.status}${error.body ? `: ${bodyExcerpt(error.body)}` : ""}`,
            };
        case "invalid_response":
            return { status: "schema_mismatch", text: `SearXNG response did not match the expected schema: ${error.issues}` };
        case "timeout":
            return {
                status: "not_json",
                text: `SearXNG did not answer with a valid JSON body: the request timed out after ${error.timeoutMs}ms`,
            };
        case "exhausted": {
            // A spent retryable status arrives as `exhausted` with an `HTTP <status>`
            // last error, because the helper reports it there and not as `http_status`.
            const statusText = error.lastError.startsWith("HTTP ") ? error.lastError.slice("HTTP ".length) : undefined;
            const status = statusText !== undefined && isAllDigits(statusText) ? statusText : null;
            if (status) {
                return {
                    status: "retryable_status",
                    httpStatus: Number(status),
                    text: `SearXNG answered HTTP ${status} and spent its retry attempt`,
                };
            }
            // A transport failure and a body that will not parse share this bucket,
            // and the text stays fixed so it never echoes a runtime parse message.
            return {
                status: "not_json",
                text: "SearXNG did not answer with a valid JSON body",
                detail: error.lastError,
            };
        }
    }
}

export type SearxngEngineDeps = {
    /** The base URL of the SearXNG instance the embedder runs. */
    readonly baseUrl: string;
};

export function createSearxngEngine(deps: SearxngEngineDeps): WebSearchEngine {
    const baseUrl = normalizeSearxngBaseUrl(deps.baseUrl);

    return {
        async search({ query, recencyFilter }: WebSearchRequest): Promise<Result<WebSearchPage, WebSearchEngineError>> {
            const params = new URLSearchParams({ q: query, format: "json" });
            if (recencyFilter !== undefined) params.set("time_range", recencyFilter);
            const response = await apiFetchValidated(`${baseUrl}/search?${params}`, SearxngSearchResponseSchema, {
                headers: { Accept: "application/json" },
                maxRetries: 0,
            });
            if (response.isErr()) return err(describeSearchFailure(response.error));
            return ok(mapSearxngResponse(response.value));
        },
    };
}
