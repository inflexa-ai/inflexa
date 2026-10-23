/**
 * `web_search` — the web step of the conversation agent's research.
 *
 * One SearXNG instance is the only engine (the embedder owns it and gives its
 * base URL at the composition root). The call rides `apiFetchValidated` with a
 * zod schema over the JSON envelope, and every failure is a normal result: the
 * spec makes an HTTP error, a spent retryable status, a schema mismatch, and a
 * body that is not JSON data variants of the ok channel, not errors of the
 * turn.
 *
 * Absence policy: SearXNG omits what no engine returned, thus every field of
 * the envelope is optional, and the mapper drops a result that misses `url` or
 * `title` and an answer that carries neither `answer` nor `url` — the
 * `search_github_repos` policy.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import { apiFetchValidated, type ApiError } from "../lib/api-utils.js";

export interface WebSearchAnswer {
    readonly answer?: string;
    readonly url?: string;
}

export interface WebSearchResult {
    readonly title: string;
    readonly url: string;
    readonly snippet?: string;
}

export type WebSearchOutput =
    | { readonly status: "ok"; readonly answers: readonly WebSearchAnswer[]; readonly results: readonly WebSearchResult[] }
    | { readonly status: "http_error"; readonly httpStatus: number; readonly text: string }
    | { readonly status: "retryable_status"; readonly httpStatus: number; readonly text: string }
    | { readonly status: "schema_mismatch"; readonly text: string }
    | { readonly status: "not_json"; readonly text: string; readonly detail?: string };

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

/** Map a parsed SearXNG envelope to the tool output rows. */
export function mapSearxngResponse(response: z.infer<typeof SearxngSearchResponseSchema>): {
    answers: WebSearchAnswer[];
    results: WebSearchResult[];
} {
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
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
}

/** The first 300 characters of a body, as the HTTP-error text reports it. */
function bodyExcerpt(body: string): string {
    return body.length > 300 ? body.slice(0, 300) : body;
}

/** Map one `ApiError` of the helper to the error data variant it names. */
export function describeSearchFailure(error: ApiError): WebSearchOutput {
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
            const status = /^HTTP (\d+)$/.exec(error.lastError);
            if (status) {
                return {
                    status: "retryable_status",
                    httpStatus: Number(status[1]),
                    text: `SearXNG answered HTTP ${status[1]} and spent its retry attempt`,
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

interface DomainFilter {
    readonly include: boolean;
    readonly domain: string;
}

function parseDomainFilter(raw: string | undefined): DomainFilter | null {
    const trimmed = (raw ?? "").trim().toLowerCase();
    if (trimmed === "" || trimmed === "-") return null;
    if (trimmed.startsWith("-")) {
        const domain = trimmed.slice(1).trim();
        return domain === "" ? null : { include: false, domain };
    }
    return { include: true, domain: trimmed };
}

function queryTerms(query: string, filter: DomainFilter | null): string {
    if (!filter) return query;
    return `${query} ${filter.include ? "" : "-"}site:${filter.domain}`;
}

/** A domain matches a host and each subdomain of the domain. */
function hostMatchesDomain(host: string, domain: string): boolean {
    return host === domain || host.endsWith(`.${domain}`);
}

function hostOf(url: string): string | null {
    try {
        return new URL(url).hostname;
    } catch {
        return null;
    }
}

/** Filter the merged rows by host again, because an engine can ignore `site:`. */
function applyDomainFilter(results: readonly WebSearchResult[], filter: DomainFilter | null): WebSearchResult[] {
    if (!filter) return [...results];
    return results.filter((result) => {
        const host = hostOf(result.url);
        if (host === null) return !filter.include;
        const matches = hostMatchesDomain(host, filter.domain);
        return filter.include ? matches : !matches;
    });
}

export interface WebSearchToolDeps {
    /** The base URL of the SearXNG instance the embedder runs. */
    readonly searxngBaseUrl: string;
}

export function createWebSearchTool(deps: WebSearchToolDeps) {
    const baseUrl = normalizeSearxngBaseUrl(deps.searxngBaseUrl);

    return defineTool({
        id: "web_search",
        description:
            "Search the web for pages: titles, URLs, and short snippets, plus any direct answers the engines returned. " +
            "Give `query` for one search, or `queries` (at most 5) for one pass whose answers and results merge into a single " +
            "list of at most `numResults` results, duplicates by URL removed. `domainFilter` restricts the search to one domain " +
            'and a leading "-" excludes it, for example "-pinterest.com". `recencyFilter` keeps only results from the last day, ' +
            "week, month, or year. Read one of the returned pages with `web_fetch`.\n" +
            "ABSENCE IS NORMAL: an empty results array means no page matched, and a status of http_error, retryable_status, " +
            "schema_mismatch, or not_json names a search that did not answer. Report either one and continue, do not retry unchanged.",
        inputSchema: z
            .object({
                query: z.string().min(1).optional().describe("One free-text search, for example a method name with its domain."),
                queries: z
                    .array(z.string().min(1))
                    .min(1)
                    .max(5)
                    .optional()
                    .describe("Up to 5 searches that run in one pass. Answers and results merge into one bounded list."),
                numResults: z.number().int().min(1).max(20).default(5).describe("Maximum merged results (1–20, default 5)."),
                recencyFilter: z.enum(["day", "week", "month", "year"]).optional().describe("Keep only results from this recency."),
                domainFilter: z
                    .string()
                    .optional()
                    .describe('One domain the search stays in, for example "nih.gov". A leading "-" excludes the domain instead.'),
            })
            .refine((input) => (input.query !== undefined) !== (input.queries !== undefined), {
                message: "Give exactly one of `query` or `queries`.",
            }),
        describeCall: "none",
        execute: async ({ query, queries, numResults, recencyFilter, domainFilter }): Promise<Result<WebSearchOutput, ToolError>> => {
            const filter = parseDomainFilter(domainFilter);
            // The input refine guarantees exactly one of `query` and `queries`.
            const queryList = queries ?? [query!];

            const requests = queryList.map((raw) => {
                const params = new URLSearchParams({ q: queryTerms(raw, filter), format: "json" });
                if (recencyFilter) params.set("time_range", recencyFilter);
                return apiFetchValidated(`${baseUrl}/search?${params}`, SearxngSearchResponseSchema, {
                    headers: { Accept: "application/json" },
                    maxRetries: 0,
                }).map((response) => mapSearxngResponse(response));
            });

            const responses: Array<{ answers: WebSearchAnswer[]; results: WebSearchResult[] }> = [];
            for (const response of await Promise.all(requests)) {
                if (response.isErr()) return ok(describeSearchFailure(response.error));
                responses.push(response.value);
            }

            const answers: WebSearchAnswer[] = [];
            const seen = new Set<string>();
            const results: WebSearchResult[] = [];
            for (const response of responses) {
                answers.push(...response.answers);
                for (const result of applyDomainFilter(response.results, filter)) {
                    if (results.length >= numResults) break;
                    if (seen.has(result.url)) continue;
                    seen.add(result.url);
                    results.push(result);
                }
            }
            return ok({ status: "ok" as const, answers, results });
        },
    });
}
