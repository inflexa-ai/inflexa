/**
 * Golden fixtures of the Ensembl REST routes that the ortholog path of the Bgee
 * client walks: the symbol lookup, then the homology route that keys on the
 * resolved gene id.
 */

import { expect } from "bun:test";

import { fixtureCase, runFixtureSuite } from "./__fixtures__/fixture-runner.js";
import { EnsemblHomologyResponseSchema, EnsemblLookupSchema } from "./bgee-client.js";

runFixtureSuite("Ensembl golden fixtures", [
    fixtureCase({
        name: "EnsemblLookupSchema",
        provider: "ensembl",
        fixture: "lookup_symbol_TP53.json",
        drift: "lookup_symbol_TP53.drift.json",
        schema: EnsemblLookupSchema,
        assertOutput: (res) => {
            // The ortholog path takes this id and calls `/homology/id/`, thus a
            // symbol never reaches the homology route.
            expect(res.id).toBe("ENSG00000141510");
        },
    }),
    fixtureCase({
        name: "EnsemblHomologyResponseSchema, the id route",
        provider: "ensembl",
        fixture: "homology_id_TP53_mouse.json",
        drift: "homology_id_TP53_mouse.drift.json",
        schema: EnsemblHomologyResponseSchema,
        assertOutput: (res) => {
            // The id route serves the envelope of the symbol route, thus the
            // reads of `resolveOrtholog` do not change with the route.
            const homologies = res.data?.[0]?.homologies ?? [];
            expect(homologies.find((homology) => homology.type === "ortholog_one2one")?.id).toBe("ENSMUSG00000059552");
        },
    }),
]);
