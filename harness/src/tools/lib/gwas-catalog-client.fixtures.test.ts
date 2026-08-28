import { expect } from "bun:test";

import { fixtureCase, runFixtureSuite } from "./__fixtures__/fixture-runner.js";
import { GwasEmbeddedSchema, GwasSnpSearchResponseSchema, GwasTraitSearchResponseSchema, mapAssociation } from "./gwas-catalog-client.js";

runFixtureSuite("GWAS Catalog golden fixtures", [
    fixtureCase({
        name: "GwasSnpSearchResponseSchema",
        provider: "gwas",
        fixture: "snp_findByGene_TP53.json",
        drift: "snp_findByGene_TP53.drift.json",
        schema: GwasSnpSearchResponseSchema,
        assertOutput: (res) => {
            const snps = res._embedded?.singleNucleotidePolymorphisms ?? [];
            expect(snps.length).toBe(2);
            // The gene path walks this link, thus a missing href stops the path.
            expect(snps[0]?._links?.associations?.href).toContain("/associations");
        },
    }),
    fixtureCase({
        name: "GwasEmbeddedSchema, the associationByStudy projection",
        provider: "gwas",
        fixture: "study_assoc_GCST000392.json",
        drift: "study_assoc_GCST000392.drift.json",
        schema: GwasEmbeddedSchema,
        assertOutput: (res) => {
            const associations = res._embedded?.associations ?? [];
            expect(associations.length).toBeGreaterThan(0);
            const mapped = mapAssociation(associations[0]!);
            // The PubMed id comes from `study.publicationInfo`, and the read at
            // the level of `study` gives an empty string forever.
            expect(mapped.pubmedId).toBe("19430480");
            expect(mapped.studyAccession).toBe("GCST000392");
            expect(mapped.sampleSize).not.toBe("");
            expect(mapped.trait).not.toBe("");
            // This projection carries no `page` key, thus `totalFound` falls back
            // to the row count.
            expect(res.page).toBeUndefined();
        },
    }),
    fixtureCase({
        name: "GwasTraitSearchResponseSchema, findByEfoTrait",
        provider: "gwas",
        fixture: "efotraits_findByEfoTrait_asthma.json",
        drift: "efotraits_findByEfoTrait_asthma.drift.json",
        schema: GwasTraitSearchResponseSchema,
        assertOutput: (res) => {
            const traits = res._embedded?.efoTraits ?? [];
            expect(traits.length).toBe(1);
            // The trait path takes the last segment of the self href as the id of
            // the association request.
            expect(traits[0]?._links?.self?.href?.split("/").pop()).toBe("MONDO_0004979");
        },
    }),
]);
