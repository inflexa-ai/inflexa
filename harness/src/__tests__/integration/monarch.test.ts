/**
 * Real-upstream checks for the Monarch Initiative association API.
 *
 * Assertions target structure and field presence, never counts or exact terms —
 * Monarch re-releases its annotation sets, so a value assertion here would fail
 * on a curation update rather than on a defect.
 */

import { describe, expect, it } from "bun:test";

import { getGenePhenotypeProfile } from "../../tools/lib/monarch-client.js";

/** Monarch's annotation payloads carry full ontology closures and are large. */
const TIMEOUT_MS = 120_000;

describe("monarch-client", () => {
    it(
        "returns human phenotype and causal-disease associations for a well-annotated gene",
        async () => {
            const profile = await getGenePhenotypeProfile("HGNC:1097");

            expect(profile.geneCurie).toBe("HGNC:1097");
            expect(profile.phenotypes.length).toBeGreaterThan(0);
            expect(profile.phenotypeTotal).toBeGreaterThanOrEqual(profile.phenotypes.length);

            const phenotype = profile.phenotypes[0]!;
            expect(phenotype.hpoId).toStartWith("HP:");
            expect(typeof phenotype.label).toBe("string");
            expect(Array.isArray(phenotype.ancestorIds)).toBe(true);
            expect(Array.isArray(phenotype.publications)).toBe(true);

            // The ancestor closure is what makes identifier-based organ
            // resolution possible; without it the consumer would be reduced to
            // matching prose.
            expect(profile.phenotypes.some((p) => p.ancestorIds.length > 0)).toBe(true);

            expect(profile.diseases.length).toBeGreaterThan(0);
            expect(profile.diseases[0]!.mondoId).toStartWith("MONDO:");
        },
        TIMEOUT_MS,
    );

    it(
        "returns an empty profile for a gene identifier Monarch does not hold",
        async () => {
            const profile = await getGenePhenotypeProfile("HGNC:99999999");

            expect(profile.phenotypes).toEqual([]);
            expect(profile.diseases).toEqual([]);
            expect(profile.phenotypesTruncated).toBe(false);
        },
        TIMEOUT_MS,
    );
});
