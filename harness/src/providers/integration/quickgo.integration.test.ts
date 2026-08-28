/**
 * Live QuickGO contract check.
 *
 * QuickGO has no standalone client file. The `lookup_annotation` tool holds the
 * request and the zod schema, thus the test drives the tool. One real request
 * proves that the live payload still passes the term schema.
 *
 * Gated on `CORTEX_LIVE_API_TESTS`. Without the gate the block runs on each
 * clean checkout, and the suite then depends on the network.
 */

import { describe, expect, test } from "bun:test";

import { lookupAnnotationTool } from "../../tools/bio/lookup-annotation.js";
import { makeToolContext } from "../../tools/__fixtures__/tool-context.js";

const LIVE = process.env.CORTEX_LIVE_API_TESTS;

/** The root of the biological-process aspect of the Gene Ontology. */
const ROOT_TERM = "GO:0008150";

describe.skipIf(!LIVE)("live QuickGO", () => {
    test("the GO term schema accepts the live payload for the biological-process root", async () => {
        const { ctx } = makeToolContext();
        const output = (await lookupAnnotationTool.execute({ vocabulary: "go", goId: ROOT_TERM }, ctx))._unsafeUnwrap();

        expect(output).toHaveProperty("terms");
        const terms = (output as { terms?: { id: string; name: string; definition?: string; aspect?: string }[] }).terms ?? [];
        expect(terms.length).toBeGreaterThan(0);
        expect(terms[0]!.id).toBe(ROOT_TERM);
        expect(terms[0]!.name.length).toBeGreaterThan(0);
    }, 60_000);
});
