/**
 * `web_search` — the web step of the conversation agent's research.
 *
 * The tool queries a `WebSearchEngine` the embedder injects at the composition
 * root; the SearXNG realization ships beside it in `searxng-engine.ts`. The
 * tool owns the input contract and the search semantics the spec pins — the
 * domain-filter terms and the host re-filter, the queries merge, the bound —
 * and every engine failure rides the ok channel as a data-status variant,
 * never as an error of the turn.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type Tool, type ToolError } from "../define-tool.js";

export type WebSearchAnswer = {
    readonly answer?: string;
    readonly url?: string;
};

export type WebSearchResult = {
    readonly title: string;
    readonly url: string;
    readonly snippet?: string;
};

export type WebSearchOutput =
    | { readonly status: "ok"; readonly answers: readonly WebSearchAnswer[]; readonly results: readonly WebSearchResult[] }
    | { readonly status: "http_error"; readonly httpStatus: number; readonly text: string }
    | { readonly status: "retryable_status"; readonly httpStatus: number; readonly text: string }
    | { readonly status: "schema_mismatch"; readonly text: string }
    | { readonly status: "not_json"; readonly text: string; readonly detail?: string };

/** One query with its terms already composed: the engine adds transport, not semantics. */
export type WebSearchRequest = {
    /** The final query text, `site:` / `-site:` terms included. */
    readonly query: string;
    readonly recencyFilter?: "day" | "week" | "month" | "year";
};

/** What one query returned: the mapped answers and the mapped result rows. */
export type WebSearchPage = {
    readonly answers: readonly WebSearchAnswer[];
    readonly results: readonly WebSearchResult[];
};

/** The error side of the engine result: the data-status variants the tool reports as normal results. */
export type WebSearchEngineError = Exclude<WebSearchOutput, { readonly status: "ok" }>;

/**
 * The injected web-search engine: an embedder supplies one realization, and the
 * conversation agent attaches `web_search` iff it did. `search` gets the final
 * query terms and the optional recency filter, and resolves to the page or to
 * the error variant that names the failure.
 */
export type WebSearchEngine = {
    search(request: WebSearchRequest): Promise<Result<WebSearchPage, WebSearchEngineError>>;
};

type DomainFilter = {
    readonly include: boolean;
    readonly domain: string;
};

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

export type WebSearchToolDeps = {
    /** The web-search engine the embedder injected. */
    readonly engine: WebSearchEngine;
};

const WebSearchInputSchema = z
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
        domainFilter: z.string().optional().describe('One domain the search stays in, for example "nih.gov". A leading "-" excludes the domain instead.'),
    })
    .refine((input) => (input.query !== undefined) !== (input.queries !== undefined), {
        message: "Give exactly one of `query` or `queries`.",
    });

export function createWebSearchTool(deps: WebSearchToolDeps): Tool<z.infer<typeof WebSearchInputSchema>, WebSearchOutput> {
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
        inputSchema: WebSearchInputSchema,
        view: "none",
        describeCall: "none",
        execute: async ({ query, queries, numResults, recencyFilter, domainFilter }): Promise<Result<WebSearchOutput, ToolError>> => {
            const filter = parseDomainFilter(domainFilter);
            // The input refine guarantees exactly one of `query` and `queries`.
            let queryList: readonly string[];
            if (queries !== undefined) queryList = queries;
            else {
                if (query === undefined) throw new Error("search requires query");
                queryList = [query];
            }

            const requests = queryList.map((raw) => deps.engine.search({ query: queryTerms(raw, filter), recencyFilter }));

            const responses: WebSearchPage[] = [];
            for (const response of await Promise.all(requests)) {
                // An engine failure is the data-status variant the tool reports, not a turn error.
                if (response.isErr()) return ok(response.error);
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
