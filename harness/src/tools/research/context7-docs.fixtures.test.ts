/**
 * The golden fixtures of the two Context7 contracts, and the routes that serve
 * them.
 *
 * The search route answers a `title` for each library, and the docs route is the
 * library path itself, which answers one `snippets` array. Both are the repaired
 * contract, thus the route assertions below ride with the schema table: a schema
 * that parses a payload of a route that nobody calls proves nothing.
 */

import { afterEach, describe, expect, it } from "bun:test";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { fixtureCase, readFixture, runFixtureSuite } from "../lib/__fixtures__/fixture-runner.js";
import { Context7DocsResponseSchema, Context7SearchResponseSchema, queryDocsTool, resolveLibraryIdTool } from "./context7-docs.js";

runFixtureSuite("context7 golden fixtures — the documentation tools", [
    fixtureCase({
        name: "Context7SearchResponseSchema — a library search",
        provider: "context7",
        fixture: "01-search-scanpy.json",
        drift: "01-search-scanpy.drift.json",
        schema: Context7SearchResponseSchema,
        assertOutput: (response) => {
            const best = response.results?.[0];
            expect(best?.id).toBe("/scverse/scanpy");
            // The display name of a library is `title` on the wire. A `name` field
            // exists on no result, thus a schema that demands one rejects every body.
            expect(best?.title).toBe("Scanpy");
            expect(best?.description).toContain("single-cell");
        },
    }),
    fixtureCase({
        name: "Context7DocsResponseSchema — the snippets of a library",
        provider: "context7",
        fixture: "08-docs-path-form.json",
        drift: "08-docs-path-form.drift.json",
        schema: Context7DocsResponseSchema,
        assertOutput: (response) => {
            expect(response.snippets).toHaveLength(7);
            const first = response.snippets[0];
            expect(first?.codeTitle).toBe("sc.get.rank_genes_groups_df");
            expect(first?.codeId).toBe("https://github.com/scverse/scanpy/blob/main/docs/api/get.md#_snippet_3");
            expect(first?.codeList[0]?.language).toBe("APIDOC");
            expect(response.snippets[1]?.codeList).toHaveLength(4);
        },
    }),
]);

const realFetch = globalThis.fetch;
let requested: string[] = [];

afterEach(() => {
    globalThis.fetch = realFetch;
    requested = [];
});

/** Answer every request with one body, and record the URL that the tool asked for. */
function serve(body: unknown, status = 200): void {
    const text = JSON.stringify(body);
    globalThis.fetch = (async (url: string) => {
        requested.push(String(url));
        return new Response(text, { status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
}

describe("the Context7 routes", () => {
    it("resolves a library name over the search route, and reports the wire title as the name", async () => {
        serve(readFixture("context7", "01-search-scanpy.json"));
        const { ctx } = makeToolContext();

        const result = (await resolveLibraryIdTool.execute({ libraryName: "scanpy", query: "differential expression" }, ctx))._unsafeUnwrap();

        expect(result).toMatchObject({ found: true, libraryId: "/scverse/scanpy", name: "Scanpy" });
        expect(result.found ? result.description : "").toContain("single-cell");
        expect(requested[0]).toBe("https://context7.com/api/v1/search?query=scanpy&topic=differential%20expression");
    });

    it("asks for the library path, and normalizes an id that carries no leading slash", async () => {
        serve(readFixture("context7", "08-docs-path-form.json"));
        const { ctx } = makeToolContext();

        await queryDocsTool.execute({ libraryId: "/scverse/scanpy", query: "rank genes" }, ctx);
        await queryDocsTool.execute({ libraryId: "scverse/scanpy", query: "rank genes" }, ctx);

        expect(requested).toEqual([
            "https://context7.com/api/v1/scverse/scanpy?type=json&topic=rank%20genes",
            "https://context7.com/api/v1/scverse/scanpy?type=json&topic=rank%20genes",
        ]);
    });

    it("maps every snippet of the docs answer into the documentation text", async () => {
        serve(readFixture("context7", "08-docs-path-form.json"));
        const { ctx } = makeToolContext();

        const result = (await queryDocsTool.execute({ libraryId: "/scverse/scanpy", query: "rank_genes_groups" }, ctx))._unsafeUnwrap();

        expect(result.found).toBe(true);
        if (result.found) {
            expect(result.documentation).toContain("### sc.get.rank_genes_groups_df");
            expect(result.documentation).toContain("Source: https://github.com/scverse/scanpy/blob/main/docs/api/get.md#_snippet_3");
            expect(result.documentation).toContain("```APIDOC");
            expect(result.documentation.split("\n\n--------------------------------\n\n")).toHaveLength(7);
        }
    });

    it("maps a library that Context7 does not hold to the found:false variant", async () => {
        serve({ error: "library_not_found", message: "Library /nosuchuser/nosuchlib not found.", snippets: [] }, 404);
        const { ctx } = makeToolContext();

        const result = (await queryDocsTool.execute({ libraryId: "/nosuchuser/nosuchlib", query: "anything" }, ctx))._unsafeUnwrap();

        expect(result.found).toBe(false);
    });

    it("maps an empty snippet list to the found:false variant", async () => {
        serve({ snippets: [] });
        const { ctx } = makeToolContext();

        const result = (await queryDocsTool.execute({ libraryId: "/scverse/scanpy", query: "anything" }, ctx))._unsafeUnwrap();

        expect(result.found).toBe(false);
    });

    it("surfaces a contract break of either route as a throw", async () => {
        const { ctx } = makeToolContext();

        serve(readFixture("context7", "01-search-scanpy.drift.json"));
        await expect(resolveLibraryIdTool.execute({ libraryName: "scanpy", query: "anything" }, ctx)).rejects.toThrow(/did not match the expected schema/);

        serve(readFixture("context7", "08-docs-path-form.drift.json"));
        await expect(queryDocsTool.execute({ libraryId: "/scverse/scanpy", query: "anything" }, ctx)).rejects.toThrow(/did not match the expected schema/);
    });
});
