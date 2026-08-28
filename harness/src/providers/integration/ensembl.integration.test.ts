/**
 * Live Ensembl REST contract check.
 *
 * The gene record is validated with zod and mapped from snake_case to the
 * camelCase `GeneInfo`. One real request proves that the live payload still
 * passes that schema.
 *
 * Gated on `CORTEX_LIVE_API_TESTS`. Without the gate the block runs on each
 * clean checkout, and the suite then depends on the network.
 */

import { describe, expect, test } from "bun:test";

import { lookupGenes } from "../../tools/lib/ensembl-client.js";

const LIVE = process.env.CORTEX_LIVE_API_TESTS;

describe.skipIf(!LIVE)("live Ensembl", () => {
    test("the gene schema accepts the live payload for TP53", async () => {
        const result = await lookupGenes(["TP53"]);

        expect(result.notFound).toEqual([]);
        expect(result.genes.length).toBe(1);

        const gene = result.genes[0]!;
        expect(gene.symbol).toBe("TP53");
        expect(gene.id).toBe("ENSG00000141510");
        expect(gene.biotype.length).toBeGreaterThan(0);
        expect(gene.assemblyName.length).toBeGreaterThan(0);
        expect(typeof gene.start).toBe("number");
        expect(typeof gene.end).toBe("number");
    }, 60_000);
});
