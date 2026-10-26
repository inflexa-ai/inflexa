import { afterEach, describe, expect, it } from "bun:test";

/** A `fetch` test double: the callable plus the `preconnect` member that `typeof fetch` carries. */
function fetchDouble(run: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof fetch {
    return Object.assign(run, { preconnect: fetch.preconnect });
}

import { requestUrlText } from "../../../lib/test/request-url.js";
import { makeToolContext } from "../../__fixtures__/tool-context.js";
import { searchArxivTool } from "../search-arxiv.js";
import { createSearchSemanticScholarTool } from "../search-semantic-scholar.js";

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

describe("shared authority discovery adapters", () => {
    it("preserves the search_arxiv input and output contract", async () => {
        let seen: URL | undefined;
        globalThis.fetch = fetchDouble((url) => {
            seen = new URL(requestUrlText(url));
            return Promise.resolve(
                new Response(`
                <feed>
                  <entry>
                    <id>http://arxiv.org/abs/2401.01234v1</id>
                    <title>Shared authority client</title>
                    <summary>One parser.</summary>
                    <published>2024-01-03T00:00:00Z</published>
                    <author><name>Jane Smith</name></author>
                    <category term="cs.LG"/>
                    <link href="https://arxiv.org/abs/2401.01234v1" rel="alternate" type="text/html"/>
                  </entry>
                </feed>
            `),
            );
        });

        const result = (await searchArxivTool.execute({ query: "shared client", categories: ["cs.LG"], limit: 4 }, makeToolContext().ctx))._unsafeUnwrap();

        expect(result).toMatchObject({ success: true, papers: [{ id: "2401.01234v1", title: "Shared authority client", authors: ["Jane Smith"] }] });
        expect(seen?.searchParams.get("search_query")).toBe("all:shared client AND (cat:cs.LG)");
        expect(seen?.searchParams.get("max_results")).toBe("4");
    });

    it("preserves the search_semantic_scholar input and output contract", async () => {
        let seen: URL | undefined;
        globalThis.fetch = fetchDouble((url) => {
            seen = new URL(requestUrlText(url));
            return Promise.resolve(
                Response.json({
                    data: [
                        {
                            paperId: "paper-1",
                            title: "Shared authority client",
                            abstract: null,
                            year: 2024,
                            venue: null,
                            citationCount: 7,
                            authors: [{ name: "Jane Smith" }],
                            externalIds: { DOI: "10.1000/example" },
                        },
                    ],
                }),
            );
        });

        const result = (await createSearchSemanticScholarTool().execute({ query: "shared client", limit: 4 }, makeToolContext().ctx))._unsafeUnwrap();

        expect(result).toEqual({
            success: true,
            papers: [
                {
                    id: "paper-1",
                    title: "Shared authority client",
                    year: 2024,
                    citationCount: 7,
                    authors: ["Jane Smith"],
                    externalIds: { DOI: "10.1000/example" },
                },
            ],
        });
        expect(seen?.searchParams.get("query")).toBe("shared client");
        expect(seen?.searchParams.get("limit")).toBe("4");
    });
});
