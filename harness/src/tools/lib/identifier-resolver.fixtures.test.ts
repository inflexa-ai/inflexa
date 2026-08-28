/**
 * The golden-fixture table of the HGNC contract that the identifier resolver reads.
 *
 * HGNC omits a key when it has no value, and it never sends an explicit null. The
 * three positive fixtures carry that policy: a protein-coding gene with
 * `uniprot_ids`, a non-coding gene without it, and a miss with an empty `docs`
 * array. The one twin breaks the type of `entrez_id`, which the wire serves as a
 * string.
 */

import { expect } from "bun:test";

import { fixtureCase, runFixtureSuite } from "./__fixtures__/fixture-runner.js";
import { HgncResponseSchema } from "./identifier-resolver.js";

runFixtureSuite("HGNC fetch", [
    fixtureCase({
        name: "HgncResponseSchema — a protein-coding gene",
        provider: "hgnc",
        fixture: "fetch-symbol-BRCA1.json",
        drift: "fetch-symbol-BRCA1.drift.json",
        schema: HgncResponseSchema,
        assertOutput: (response) => {
            const doc = response.response?.docs?.[0];
            expect(doc?.symbol).toBe("BRCA1");
            expect(doc?.name).toBe("BRCA1 DNA repair associated");
            expect(doc?.hgnc_id).toBe("HGNC:1100");
            expect(doc?.ensembl_gene_id).toBe("ENSG00000012048");
            expect(doc?.uniprot_ids).toEqual(["P38398"]);
            expect(doc?.entrez_id).toBe("672");
            expect(doc?.alias_symbol).toContain("FANCS");
        },
    }),
    fixtureCase({
        name: "HgncResponseSchema — a non-coding gene omits uniprot_ids",
        provider: "hgnc",
        fixture: "fetch-symbol-LINC00115.json",
        drift: "fetch-symbol-BRCA1.drift.json",
        schema: HgncResponseSchema,
        assertOutput: (response) => {
            const doc = response.response?.docs?.[0];
            expect(doc?.symbol).toBe("LINC00115");
            expect(doc?.ensembl_gene_id).toBe("ENSG00000225880");
            // The key is absent, thus the resolver reads `undefined` and leaves the
            // UniProt seed to the symbol lookup.
            expect(doc).not.toHaveProperty("uniprot_ids");
            expect(doc?.prev_symbol).toEqual(["NCRNA00115"]);
        },
    }),
    fixtureCase({
        name: "HgncResponseSchema — a miss",
        provider: "hgnc",
        fixture: "fetch-symbol-NOTAREALGENE123.json",
        drift: "fetch-symbol-BRCA1.drift.json",
        schema: HgncResponseSchema,
        assertOutput: (response) => {
            // A miss is HTTP 200 with an empty `docs` array, thus the resolver maps it
            // to no document instead of an error.
            expect(response.response?.docs).toEqual([]);
        },
    }),
]);
