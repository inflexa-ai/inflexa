/**
 * Live KEGG contract check.
 *
 * KEGG serves plain TSV, thus there is no zod schema here. The guard is the
 * parse path: the gene resolution, the pathway links, and the pathway names.
 * One real call proves that the live text still parses into rows.
 *
 * Gated on `CORTEX_LIVE_API_TESTS`. Without the gate the block runs on each
 * clean checkout, and the suite then depends on the network.
 */

import { describe, expect, test } from "bun:test";

import { keggPathwaysForGene } from "../../tools/lib/pathway-client.js";

const LIVE = process.env.CORTEX_LIVE_API_TESTS;

describe.skipIf(!LIVE)("live KEGG", () => {
    test("the parse path returns pathway rows for TP53", async () => {
        const pathways = await keggPathwaysForGene("TP53", "hsa", 5);

        expect(pathways.length).toBeGreaterThan(0);
        for (const pathway of pathways) {
            expect(pathway.source).toBe("kegg");
            expect(pathway.id).toMatch(/^hsa\d{5}$/);
            // A row that keeps the identifier as its name means that the name
            // lookup gave nothing, thus the parse path is broken.
            expect(pathway.name).not.toBe(pathway.id);
            expect(pathway.url).toContain(pathway.id);
        }
    }, 60_000);
});
