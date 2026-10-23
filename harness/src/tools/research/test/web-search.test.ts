/**
 * The tool-level suite of `web_search` over a stubbed web-search engine.
 *
 * The SearXNG wire contract (the request URL, the schema, the error texts)
 * lives in `searxng-engine.test.ts`. Here the engine is a stub that records
 * what the tool asked for, so every test pins the semantics the tool owns:
 * the domain-filter terms and the host re-filter, the queries merge, the
 * bound, and the rule that an engine failure rides the ok channel.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { err, ok } from "neverthrow";

import { makeToolContext } from "../../__fixtures__/tool-context.js";
import {
    createWebSearchTool,
    type WebSearchEngine,
    type WebSearchEngineError,
    type WebSearchOutput,
    type WebSearchPage,
    type WebSearchRequest,
} from "../web-search.js";

let requests: WebSearchRequest[] = [];

/** An engine that answers each composed query from a table, and records what the tool asked. */
function stubEngine(byQuery: Record<string, WebSearchPage | WebSearchEngineError>): WebSearchEngine {
    return {
        async search(request) {
            requests.push(request);
            const answer = byQuery[request.query];
            if (answer === undefined) throw new Error(`no stubbed page for query ${request.query}`);
            return "status" in answer ? err(answer) : ok(answer);
        },
    };
}

afterEach(() => {
    requests = [];
});

async function search(raw: Record<string, unknown>, engine: WebSearchEngine): Promise<WebSearchOutput> {
    const tool = createWebSearchTool({ engine });
    // The loop parses the model input through the schema before it runs the body
    // (run-agent.ts), thus the defaults and the input refine are part of the path.
    const input = tool.inputSchema.parse(raw) as Parameters<typeof tool.execute>[0];
    const { ctx } = makeToolContext();
    const result = await tool.execute(input, ctx);
    return result._unsafeUnwrap() as WebSearchOutput;
}

function resultsOf(output: WebSearchOutput): string[] {
    return output.status === "ok" ? output.results.map((r) => r.url) : [];
}

describe("web_search — the passed-through page", () => {
    it("reports the engine's answers and results, and an empty page as a normal result", async () => {
        const page: WebSearchPage = {
            answers: [{ answer: "TP53 is a tumor suppressor gene.", url: "https://en.wikipedia.org/wiki/TP53" }],
            results: [{ title: "TP53 gene", url: "https://www.ncbi.nlm.nih.gov/gene/7157", snippet: "Tumor protein p53." }],
        };

        const output = await search({ query: "tp53" }, stubEngine({ tp53: page }));

        expect(output).toEqual({ status: "ok", answers: page.answers, results: page.results });
        expect(await search({ query: "zzqqxxnosuchterm" }, stubEngine({ zzqqxxnosuchterm: { answers: [], results: [] } }))).toEqual({
            status: "ok",
            answers: [],
            results: [],
        });
    });
});

describe("web_search — numResults", () => {
    const many: WebSearchPage = {
        answers: [],
        results: Array.from({ length: 7 }, (_, i) => ({ title: `Page ${i}`, url: `https://example.org/p${i}`, snippet: `snippet ${i}` })),
    };
    const engine = () => stubEngine({ q: many });

    it("cuts at the default of 5", async () => {
        const output = await search({ query: "q" }, engine());

        expect(resultsOf(output)).toHaveLength(5);
        expect(resultsOf(output)[0]).toBe("https://example.org/p0");
    });

    it("honors an explicit cap up to 20", async () => {
        expect(resultsOf(await search({ query: "q", numResults: 2 }, engine()))).toHaveLength(2);
        expect(resultsOf(await search({ query: "q", numResults: 20 }, engine()))).toHaveLength(7);
    });
});

describe("web_search — the domain filter", () => {
    it("excludes a domain: the query gains -site:, and its hosts and subdomains drop", async () => {
        const engine = stubEngine({
            "q -site:example.com": {
                answers: [],
                results: [
                    { title: "Kept", url: "https://example.org/kept" },
                    { title: "Dropped", url: "https://example.com/dropped" },
                    { title: "Dropped subdomain", url: "https://docs.example.com/dropped" },
                ],
            },
        });

        const output = await search({ query: "q", domainFilter: "-example.com" }, engine);

        expect(resultsOf(output)).toEqual(["https://example.org/kept"]);
        expect(requests.map((r) => r.query)).toEqual(["q -site:example.com"]);
    });

    it("restricts to a domain: the query gains site:, and the host filter drops what an engine ignored", async () => {
        const engine = stubEngine({
            "q site:nih.gov": {
                answers: [],
                results: [
                    { title: "Direct", url: "https://nih.gov/direct" },
                    { title: "Subdomain", url: "https://www.ncbi.nlm.nih.gov/sub" },
                    { title: "Outside", url: "https://example.org/outside" },
                ],
            },
        });

        const output = await search({ query: "q", domainFilter: "nih.gov" }, engine);

        expect(resultsOf(output)).toEqual(["https://nih.gov/direct", "https://www.ncbi.nlm.nih.gov/sub"]);
        expect(requests.map((r) => r.query)).toEqual(["q site:nih.gov"]);
    });
});

describe("web_search — the recency filter", () => {
    it("passes through to the engine request", async () => {
        await search({ query: "q", recencyFilter: "month" }, stubEngine({ q: { answers: [], results: [] } }));

        expect(requests).toEqual([{ query: "q", recencyFilter: "month" }]);
    });
});

describe("web_search — several queries merge into one bounded list", () => {
    it("merges the answers and the results in query order, removes duplicates by URL, and cuts at numResults", async () => {
        const engine = stubEngine({
            "first query": {
                answers: [{ answer: "First answer." }],
                results: [
                    { title: "A", url: "https://example.org/a" },
                    { title: "B", url: "https://example.org/b" },
                    { title: "C", url: "https://example.org/c" },
                ],
            },
            "second query": {
                answers: [{ answer: "Second answer." }],
                results: [
                    { title: "A again", url: "https://example.org/a" },
                    { title: "D", url: "https://example.org/d" },
                    { title: "E", url: "https://example.org/e" },
                ],
            },
        });

        const output = await search({ queries: ["first query", "second query"], numResults: 4 }, engine);

        expect(output.status).toBe("ok");
        if (output.status !== "ok") return;
        expect(output.answers).toEqual([{ answer: "First answer." }, { answer: "Second answer." }]);
        expect(output.results.map((r) => r.url)).toEqual(["https://example.org/a", "https://example.org/b", "https://example.org/c", "https://example.org/d"]);
        expect(requests.map((r) => r.query)).toEqual(["first query", "second query"]);
    });

    it("runs one engine call for each query, at most 5", async () => {
        await search(
            { queries: ["one", "two", "three", "four", "five"] },
            stubEngine({
                one: { answers: [], results: [] },
                two: { answers: [], results: [] },
                three: { answers: [], results: [] },
                four: { answers: [], results: [] },
                five: { answers: [], results: [] },
            }),
        );

        expect(requests).toHaveLength(5);
    });
});

describe("web_search — an engine failure rides the ok channel", () => {
    it.each([
        [{ status: "http_error", httpStatus: 500, text: "SearXNG answered HTTP 500: crashed" }],
        [{ status: "retryable_status", httpStatus: 503, text: "SearXNG answered HTTP 503 and spent its retry attempt" }],
        [{ status: "schema_mismatch", text: "SearXNG response did not match the expected schema: results" }],
        [{ status: "not_json", text: "SearXNG did not answer with a valid JSON body" }],
    ] as [WebSearchEngineError][])("reports %s verbatim as a normal result", async (error) => {
        const output = await search({ query: "q" }, stubEngine({ q: error }));

        expect(output).toEqual(error);
    });
});

describe("web_search — the input contract", () => {
    const schema = createWebSearchTool({ engine: stubEngine({}) }).inputSchema;

    it("rejects an input that holds neither or both of query and queries", () => {
        expect(schema.safeParse({}).success).toBe(false);
        expect(schema.safeParse({ query: "a", queries: ["b"] }).success).toBe(false);
    });

    it("bounds the queries at 5 and numResults between 1 and 20", () => {
        expect(schema.safeParse({ queries: ["1", "2", "3", "4", "5", "6"] }).success).toBe(false);
        expect(schema.safeParse({ query: "q", numResults: 0 }).success).toBe(false);
        expect(schema.safeParse({ query: "q", numResults: 21 }).success).toBe(false);
    });
});
