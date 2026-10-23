/**
 * The recorded-response suite of `web_search`.
 *
 * Every test serves a recorded body through a fetch stub, thus no test reaches
 * the network. The error tests assert the error text of each bucket the spec
 * names, and the query tests assert the exact request URL the tool builds:
 * the `site:` terms, the `time_range` parameter, and the merged, bounded list
 * of a multi-query call.
 */

import { afterEach, describe, expect, it } from "bun:test";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { createWebSearchTool, normalizeSearxngBaseUrl, type WebSearchOutput } from "./web-search.js";

const BASE_URL = "http://127.0.0.1:28437";

const realFetch = globalThis.fetch;
let requested: string[] = [];

afterEach(() => {
    globalThis.fetch = realFetch;
    requested = [];
});

/** Answer every request with one JSON body, and record the URL the tool asked for. */
function serve(body: unknown, status = 200): void {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    globalThis.fetch = (async (url: string) => {
        requested.push(String(url));
        return new Response(text, { status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
}

/** Answer each request from its `q` parameter, and record the URLs. */
function serveByQuery(bodies: Record<string, unknown>): void {
    globalThis.fetch = (async (url: string) => {
        const requestUrl = String(url);
        requested.push(requestUrl);
        const q = new URL(requestUrl).searchParams.get("q") ?? "";
        const body = bodies[q];
        if (body === undefined) throw new Error(`no recorded body for query ${q}`);
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
}

async function search(raw: Record<string, unknown>): Promise<WebSearchOutput> {
    const tool = createWebSearchTool({ searxngBaseUrl: BASE_URL });
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

describe("web_search — the mapped answer", () => {
    it("returns answers and mapped results", async () => {
        serve({
            answers: [
                { answer: "TP53 is a tumor suppressor gene.", url: "https://en.wikipedia.org/wiki/TP53", template: "wikipedia.html" },
                { url: "https://www.ncbi.nlm.nih.gov/gene/7157" },
                { answer: "Also known as p53." },
                { template: "answer.html" },
            ],
            results: [
                { title: "TP53 gene", url: "https://www.ncbi.nlm.nih.gov/gene/7157", content: "Tumor protein p53.", engine: "bing", score: 1.5 },
                { title: "No snippet here", url: "https://example.org/tp53", content: null },
                { url: "https://example.org/no-title" },
                { title: "No URL here", content: "…" },
            ],
        });

        const output = await search({ query: "tp53" });

        expect(output.status).toBe("ok");
        if (output.status !== "ok") return;
        expect(output.answers).toEqual([
            { answer: "TP53 is a tumor suppressor gene.", url: "https://en.wikipedia.org/wiki/TP53" },
            { url: "https://www.ncbi.nlm.nih.gov/gene/7157" },
            { answer: "Also known as p53." },
        ]);
        expect(output.results).toEqual([
            { title: "TP53 gene", url: "https://www.ncbi.nlm.nih.gov/gene/7157", snippet: "Tumor protein p53." },
            { title: "No snippet here", url: "https://example.org/tp53", snippet: undefined },
        ]);
        expect(requested).toEqual([`${BASE_URL}/search?q=tp53&format=json`]);
    });

    it("returns an empty list as a normal result, over a body that holds no key", async () => {
        serve({});

        const output = await search({ query: "zzqqxxnosuchterm" });

        expect(output).toEqual({ status: "ok", answers: [], results: [] });
    });
});

describe("web_search — numResults", () => {
    const many = {
        results: Array.from({ length: 7 }, (_, i) => ({ title: `Page ${i}`, url: `https://example.org/p${i}`, content: `snippet ${i}` })),
    };

    it("cuts at the default of 5", async () => {
        serve(many);

        const output = await search({ query: "q" });

        expect(resultsOf(output)).toHaveLength(5);
        expect(resultsOf(output)[0]).toBe("https://example.org/p0");
    });

    it("honors an explicit cap up to 20", async () => {
        serve(many);

        expect(resultsOf(await search({ query: "q", numResults: 2 }))).toHaveLength(2);
        expect(resultsOf(await search({ query: "q", numResults: 20 }))).toHaveLength(7);
    });
});

describe("web_search — the domain filter", () => {
    it("excludes a domain: the query gains -site:, and its hosts and subdomains drop", async () => {
        serveByQuery({
            "q -site:example.com": {
                results: [
                    { title: "Kept", url: "https://example.org/kept" },
                    { title: "Dropped", url: "https://example.com/dropped" },
                    { title: "Dropped subdomain", url: "https://docs.example.com/dropped" },
                ],
            },
        });

        const output = await search({ query: "q", domainFilter: "-example.com" });

        expect(resultsOf(output)).toEqual(["https://example.org/kept"]);
    });

    it("restricts to a domain: the query gains site:, and the host filter drops what an engine ignored", async () => {
        serveByQuery({
            "q site:nih.gov": {
                results: [
                    { title: "Direct", url: "https://nih.gov/direct" },
                    { title: "Subdomain", url: "https://www.ncbi.nlm.nih.gov/sub" },
                    { title: "Outside", url: "https://example.org/outside" },
                ],
            },
        });

        const output = await search({ query: "q", domainFilter: "nih.gov" });

        expect(resultsOf(output)).toEqual(["https://nih.gov/direct", "https://www.ncbi.nlm.nih.gov/sub"]);
    });
});

describe("web_search — the recency filter", () => {
    it("maps to the SearXNG time_range parameter", async () => {
        serveByQuery({ q: {} });

        await search({ query: "q", recencyFilter: "month" });

        expect(requested).toEqual([`${BASE_URL}/search?q=q&format=json&time_range=month`]);
    });
});

describe("web_search — several queries merge into one bounded list", () => {
    it("merges the answers and the results in query order, removes duplicates by URL, and cuts at numResults", async () => {
        serveByQuery({
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

        const output = await search({ queries: ["first query", "second query"], numResults: 4 });

        expect(output.status).toBe("ok");
        if (output.status !== "ok") return;
        expect(output.answers).toEqual([{ answer: "First answer." }, { answer: "Second answer." }]);
        expect(output.results.map((r) => r.url)).toEqual(["https://example.org/a", "https://example.org/b", "https://example.org/c", "https://example.org/d"]);
        expect(requested).toEqual([`${BASE_URL}/search?q=first+query&format=json`, `${BASE_URL}/search?q=second+query&format=json`]);
    });

    it("runs one request for each query, at most 5", async () => {
        serveByQuery({});
        await search({ queries: ["one", "two", "three", "four", "five"] });
        expect(requested).toHaveLength(5);
    });
});

describe("web_search — the error texts", () => {
    it("names an HTTP error status and a bounded excerpt of the body", async () => {
        serve("SearXNG crashed: the formats setting holds no json", 500);

        const output = await search({ query: "q" });

        expect(output).toEqual({
            status: "http_error",
            httpStatus: 500,
            text: "SearXNG answered HTTP 500: SearXNG crashed: the formats setting holds no json",
        });
    });

    it("bounds the excerpt of a long error body at 300 characters", async () => {
        const body = "x".repeat(400);
        serve(body, 500);

        const output = await search({ query: "q" });

        expect(output.status).toBe("http_error");
        if (output.status !== "http_error") return;
        expect(output.text).toBe(`SearXNG answered HTTP 500: ${"x".repeat(300)}`);
        expect(output.text.length).toBeLessThan(body.length + 40);
    });

    it("names a retryable status that spent its attempt", async () => {
        serve("Service Unavailable", 503);

        const output = await search({ query: "q" });

        expect(output).toEqual({ status: "retryable_status", httpStatus: 503, text: "SearXNG answered HTTP 503 and spent its retry attempt" });
    });

    it("names that a body was not valid JSON, distinct from the HTTP error text", async () => {
        globalThis.fetch = (async () =>
            new Response("<html>not json</html>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;

        const output = await search({ query: "q" });

        expect(output.status).toBe("not_json");
        if (output.status !== "not_json") return;
        expect(output.text).toBe("SearXNG did not answer with a valid JSON body");
        expect(output.text).not.toContain("HTTP");
    });

    it("names a schema mismatch", async () => {
        serve({ results: "search is unavailable" });

        const output = await search({ query: "q" });

        expect(output.status).toBe("schema_mismatch");
        if (output.status !== "schema_mismatch") return;
        expect(output.text).toContain("did not match the expected schema");
    });
});

describe("web_search — the input contract", () => {
    const schema = createWebSearchTool({ searxngBaseUrl: BASE_URL }).inputSchema;

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

describe("normalizeSearxngBaseUrl", () => {
    it("strips the query, the fragment, and a trailing slash", () => {
        expect(normalizeSearxngBaseUrl("http://127.0.0.1:28437/")).toBe("http://127.0.0.1:28437");
        expect(normalizeSearxngBaseUrl("https://search.example.org/searxng/?a=b#frag")).toBe("https://search.example.org/searxng");
    });

    it("refuses a scheme that is not http or https", () => {
        expect(() => normalizeSearxngBaseUrl("file:///etc/searxng")).toThrow(/http or https/);
        expect(() => normalizeSearxngBaseUrl("ftp://127.0.0.1:28437")).toThrow(/http or https/);
    });

    it("refuses a user name or a password", () => {
        expect(() => normalizeSearxngBaseUrl("http://user:pass@127.0.0.1:28437")).toThrow(/no user name or password/);
    });

    it("builds the request from the normalized base URL", async () => {
        serve({});

        const tool = createWebSearchTool({ searxngBaseUrl: "http://127.0.0.1:28437/?a=b" });
        const { ctx } = makeToolContext();
        await tool.execute(tool.inputSchema.parse({ query: "q" }) as Parameters<typeof tool.execute>[0], ctx);

        expect(requested).toEqual([`${BASE_URL}/search?q=q&format=json`]);
    });
});
