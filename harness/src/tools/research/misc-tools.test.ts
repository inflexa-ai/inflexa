import { afterEach, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { resolveLibraryIdTool } from "./context7-docs.js";
import { createInspectRunTool } from "./inspect-run.js";

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

function stubFetch(response: () => Response): void {
    globalThis.fetch = (async () => response()) as unknown as typeof fetch;
}

describe("resolveLibraryId (remaining-leaf family)", () => {
    it("returns a populated data variant for a resolved library", async () => {
        stubFetch(
            () =>
                new Response(
                    JSON.stringify({
                        results: [
                            {
                                id: "/scverse/scanpy",
                                name: "scanpy",
                                description: "Single-cell analysis in Python",
                            },
                        ],
                    }),
                    { status: 200, headers: { "content-type": "application/json" } },
                ),
        );

        const { ctx } = makeToolContext();
        const result = (await resolveLibraryIdTool.execute({ libraryName: "scanpy", query: "differential expression" }, ctx))._unsafeUnwrap();

        expect(result.found).toBe(true);
        if (result.found) expect(result.libraryId).toBe("/scverse/scanpy");
    });

    it("returns the found:false variant when no library matches", async () => {
        stubFetch(
            () =>
                new Response(JSON.stringify({ results: [] }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                }),
        );

        const { ctx } = makeToolContext();
        const result = (await resolveLibraryIdTool.execute({ libraryName: "nonexistent-lib", query: "anything" }, ctx))._unsafeUnwrap();

        expect(result.found).toBe(false);
    });

    it("throws on an upstream 5xx failure", async () => {
        stubFetch(() => new Response("upstream down", { status: 500 }));

        const { ctx } = makeToolContext();
        await expect(resolveLibraryIdTool.execute({ libraryName: "scanpy", query: "anything" }, ctx)).rejects.toThrow();
    });
});

describe("inspectRun (dependency-bearing factory)", () => {
    it("derives the analysis id from the Session and lists runs via the injected pool", async () => {
        const fakePool = {
            query: async () => ({ rows: [] }),
        } as unknown as Pool;

        const tool = createInspectRunTool(fakePool);
        const { ctx } = makeToolContext();
        const result = (await tool.execute({}, ctx))._unsafeUnwrap();

        expect(result).toEqual({ message: "No runs found for this analysis." });
    });
});
