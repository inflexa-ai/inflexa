/**
 * Live Context7 contract check.
 *
 * Context7 has no standalone client file. The `resolve_library_id` tool holds
 * the request and the zod schema, thus the test drives the tool. One real
 * request proves that the live payload still passes that schema.
 *
 * Gated on `CORTEX_LIVE_API_TESTS`. Without the gate the block runs on each
 * clean checkout, and the suite then depends on the network.
 */

import { describe, expect, test } from "bun:test";

import { resolveLibraryIdTool } from "../../../tools/research/context7-docs.js";
import { makeToolContext } from "../../../tools/__fixtures__/tool-context.js";

const LIVE = process.env.CORTEX_LIVE_API_TESTS;

describe.skipIf(!LIVE)("live Context7", () => {
    test("the search schema accepts the live payload for a canonical library", async () => {
        const { ctx } = makeToolContext();
        const output = (await resolveLibraryIdTool.execute({ libraryName: "scanpy", query: "differential expression" }, ctx))._unsafeUnwrap();

        expect(output.found).toBe(true);
        // SAFETY: the value is test-controlled — a fixture, a double answer, or the unit under test answering the input this test built — so the cast names a shape the test itself determines.
        const resolved = output as { found: true; libraryId: string; name: string; description: string };
        expect(resolved.libraryId.length).toBeGreaterThan(0);
        expect(resolved.name.length).toBeGreaterThan(0);
        expect(typeof resolved.description).toBe("string");
    }, 60_000);
});
