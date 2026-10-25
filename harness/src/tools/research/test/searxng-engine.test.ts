/**
 * The recorded-response suite of the SearXNG engine realization.
 *
 * Every test serves a recorded body through a fetch stub, thus no test reaches
 * the network. The request tests assert the exact URL the realization builds
 * (the normalized base, `format=json`, `time_range`), and the error tests
 * assert the error variant each failure bucket names.
 */

import { afterEach, describe, expect, it } from "bun:test";

/** A `fetch` test double: the callable plus the `preconnect` member that `typeof fetch` carries. */
function fetchDouble(run: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof fetch {
    return Object.assign(run, { preconnect: fetch.preconnect });
}

import { createSearxngEngine, mapSearxngResponse, normalizeSearxngBaseUrl } from "../searxng-engine.js";
import { awaitOk } from "../../../lib/test/result-assert.js";

const BASE_URL = "http://127.0.0.1:28437";

const realFetch = globalThis.fetch;
let requested: string[] = [];

afterEach(() => {
    globalThis.fetch = realFetch;
    requested = [];
});

/** Answer every request with one JSON body, and record the URL the engine asked for. */
function serve(body: unknown, status = 200): void {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    globalThis.fetch = fetchDouble((url) => {
        requested.push(String(url));
        return Promise.resolve(new Response(text, { status, headers: { "content-type": "application/json" } }));
    });
}

describe("createSearxngEngine — the request", () => {
    it("builds the search URL with format=json from the normalized base URL", async () => {
        serve({});
        const engine = createSearxngEngine({ baseUrl: "http://127.0.0.1:28437/?a=b" });

        await awaitOk(engine.search({ query: "q" }));

        expect(requested).toEqual([`${BASE_URL}/search?q=q&format=json`]);
    });

    it("passes the query verbatim and adds time_range only when a recency filter is given", async () => {
        serve({});
        const engine = createSearxngEngine({ baseUrl: BASE_URL });

        await awaitOk(engine.search({ query: "q -site:example.com" }));
        await awaitOk(engine.search({ query: "q", recencyFilter: "month" }));

        expect(requested).toEqual([`${BASE_URL}/search?q=q+-site%3Aexample.com&format=json`, `${BASE_URL}/search?q=q&format=json&time_range=month`]);
    });
});

describe("mapSearxngResponse — the envelope", () => {
    it("maps answers and results, and drops a row that carries neither title and url nor answer and url", () => {
        const mapped = mapSearxngResponse({
            answers: [
                { answer: "TP53 is a tumor suppressor gene.", url: "https://en.wikipedia.org/wiki/TP53", template: "wikipedia.html" },
                { url: "https://www.ncbi.nlm.nih.gov/gene/7157" },
                { answer: "Also known as p53." },
                { template: "answer.html" },
            ],
            results: [
                { title: "TP53 gene", url: "https://www.ncbi.nlm.nih.gov/gene/7157", content: "Tumor protein p53." },
                { title: "No snippet here", url: "https://example.org/tp53", content: null },
                { url: "https://example.org/no-title" },
                { title: "No URL here", content: "…" },
            ],
        });

        expect(mapped.answers).toEqual([
            { answer: "TP53 is a tumor suppressor gene.", url: "https://en.wikipedia.org/wiki/TP53" },
            { url: "https://www.ncbi.nlm.nih.gov/gene/7157" },
            { answer: "Also known as p53." },
        ]);
        expect(mapped.results).toEqual([
            { title: "TP53 gene", url: "https://www.ncbi.nlm.nih.gov/gene/7157", snippet: "Tumor protein p53." },
            { title: "No snippet here", url: "https://example.org/tp53", snippet: undefined },
        ]);
    });

    it("returns an empty page over a body that holds no key", () => {
        expect(mapSearxngResponse({})).toEqual({ answers: [], results: [] });
    });
});

describe("createSearxngEngine — the error variants", () => {
    const engine = createSearxngEngine({ baseUrl: BASE_URL });

    it("names an HTTP error status and a bounded excerpt of the body", async () => {
        serve("SearXNG crashed: the formats setting holds no json", 500);

        const outcome = await engine.search({ query: "q" });

        expect(outcome._unsafeUnwrapErr()).toEqual({
            status: "http_error",
            httpStatus: 500,
            text: "SearXNG answered HTTP 500: SearXNG crashed: the formats setting holds no json",
        });
    });

    it("bounds the excerpt of a long error body at 300 characters", async () => {
        serve("x".repeat(400), 500);

        const outcome = await engine.search({ query: "q" });
        const error = outcome._unsafeUnwrapErr();
        if (error.status !== "http_error") throw new Error("expected http_error");

        expect(error.text).toBe(`SearXNG answered HTTP 500: ${"x".repeat(300)}`);
    });

    it("names a retryable status that spent its attempt", async () => {
        serve("Service Unavailable", 503);

        const outcome = await engine.search({ query: "q" });

        expect(outcome._unsafeUnwrapErr()).toEqual({
            status: "retryable_status",
            httpStatus: 503,
            text: "SearXNG answered HTTP 503 and spent its retry attempt",
        });
    });

    it("names that a body was not valid JSON, distinct from the HTTP error text", async () => {
        globalThis.fetch = fetchDouble(() => Promise.resolve(new Response("<html>not json</html>", { status: 200, headers: { "content-type": "text/html" } })));

        const outcome = await engine.search({ query: "q" });
        const error = outcome._unsafeUnwrapErr();
        if (error.status !== "not_json") throw new Error("expected not_json");

        expect(error.text).toBe("SearXNG did not answer with a valid JSON body");
        expect(error.text).not.toContain("HTTP");
    });

    it("names a schema mismatch", async () => {
        serve({ results: "search is unavailable" });

        const outcome = await engine.search({ query: "q" });
        const error = outcome._unsafeUnwrapErr();
        if (error.status !== "schema_mismatch") throw new Error("expected schema_mismatch");

        expect(error.text).toContain("did not match the expected schema");
    });
});

describe("normalizeSearxngBaseUrl", () => {
    it("strips the query, the fragment, and a trailing slash", () => {
        expect(normalizeSearxngBaseUrl("http://127.0.0.1:28437/")).toBe("http://127.0.0.1:28437");
        expect(normalizeSearxngBaseUrl("https://search.example.org/searxng/?a=b#frag")).toBe("https://search.example.org/searxng");
    });

    it("refuses a scheme that is not http or https", () => {
        expect(() => normalizeSearxngBaseUrl("file:///etc/searxng")).toThrow("http or https");
        expect(() => normalizeSearxngBaseUrl("ftp://127.0.0.1:28437")).toThrow("http or https");
    });

    it("refuses a user name or a password", () => {
        expect(() => normalizeSearxngBaseUrl("http://user:pass@127.0.0.1:28437")).toThrow("no user name or password");
    });
});
