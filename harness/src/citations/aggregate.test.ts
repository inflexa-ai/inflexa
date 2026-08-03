import { describe, expect, it } from "bun:test";

import { aggregateCitationResolution } from "./aggregate.js";
import { normalizeCitation } from "./normalize.js";
import type { CitationInput, CitationRecord, CitationSource, CitationSourceOutcome } from "./types.js";

function record(source: CitationSource, sourceRecordId: string, fields: Partial<CitationRecord>): CitationRecord {
    return { source, sourceRecordId, identifiers: {}, ...fields };
}

function outcome(source: CitationSource, status: CitationSourceOutcome["status"], records: CitationRecord[] = []): CitationSourceOutcome {
    return { source, operation: "test", status, requestCount: status === "not_applicable" ? 0 : 1, records };
}

function aggregate(input: CitationInput, outcomes: CitationSourceOutcome[], config?: Parameters<typeof aggregateCitationResolution>[3]) {
    return aggregateCitationResolution(input, normalizeCitation(input), outcomes, config);
}

describe("citation candidate clustering", () => {
    it("clusters records sharing a normalized strong identifier and exposes conflicts", () => {
        const input = { citation: "10.1000/example", title: "Example study", year: 2021 };
        const result = aggregate(input, [
            outcome("doi_registry", "ok", [
                record("doi_registry", "10.1000/example", { identifiers: { doi: "10.1000/example" }, title: "Example study", year: 2021 }),
            ]),
            outcome("crossref", "ok", [
                record("crossref", "10.1000/example", { identifiers: { doi: "10.1000/example" }, title: "Corrupted example title", year: 2020 }),
            ]),
        ]);

        expect(result.candidates).toHaveLength(1);
        expect(result.candidates[0]?.records).toHaveLength(2);
        expect(result.conflicts.map((conflict) => conflict.field)).toEqual(["title", "year"]);
        expect(result.verdict).toBe("metadata_mismatch");
    });

    it("keeps highly similar preprint and journal identifiers separate and relates them", () => {
        const input = { citation: "A precise title", title: "A precise title", authors: ["Jane Smith"], year: 2024 };
        const result = aggregate(input, [
            outcome("arxiv", "ok", [
                record("arxiv", "2401.01234", { identifiers: { arxiv: "2401.01234" }, title: "A precise title", authors: ["Jane Smith"], year: 2023 }),
            ]),
            outcome("crossref", "ok", [
                record("crossref", "10.1000/example", {
                    identifiers: { doi: "10.1000/example" },
                    title: "A precise title",
                    authors: ["Jane Smith"],
                    year: 2024,
                }),
            ]),
        ]);

        expect(result.candidates).toHaveLength(2);
        expect(
            result.candidates
                .flatMap((cluster) => cluster.relations)
                .map((relation) => relation.kind)
                .sort(),
        ).toEqual(["preprint_of", "published_as"]);
    });

    it("does not select weak or tied bibliographic candidates", () => {
        const input = { citation: "Generic study about cells" };
        const result = aggregate(
            input,
            [
                outcome("crossref", "ok", [record("crossref", "one", { title: "Generic study about the cells" })]),
                outcome("semantic_scholar", "ok", [record("semantic_scholar", "two", { title: "Generic study about cells" })]),
            ],
            { minimumScore: 0.5, separationMargin: 0.2, clusterSimilarity: 0.99, relatedVersionSimilarity: 1 },
        );

        expect(result.selectedClusterId).toBeUndefined();
        expect(result.verdict).toBe("not_found");
    });
});

describe("metadata comparison, verdict, and coverage", () => {
    it("verifies an exact identifier-only record without inventing comparisons", () => {
        const input = { citation: "10.1000/example" };
        const result = aggregate(input, [
            {
                ...outcome("doi_registry", "ok", [record("doi_registry", "10.1000/example", { identifiers: { doi: "10.1000/example" } })]),
                identifierEvidence: { type: "doi", identifier: "10.1000/example", exists: true, metadataAvailable: false },
            },
        ]);

        expect(result.comparisons).toEqual([]);
        expect(result.verdict).toBe("verified");
        expect(result.coverage).toBe("complete");
    });

    it("marks requested missing metadata inconclusive with partial coverage", () => {
        const input = { citation: "10.1000/example", venue: "Example Journal" };
        const result = aggregate(input, [
            {
                ...outcome("doi_registry", "unavailable", [record("doi_registry", "10.1000/example", { identifiers: { doi: "10.1000/example" } })]),
                identifierEvidence: { type: "doi", identifier: "10.1000/example", exists: true, metadataAvailable: false },
            },
        ]);

        expect(result.comparisons).toEqual([
            expect.objectContaining({ field: "venue", status: "not_compared", supplied: "Example Journal", sourceValues: [] }),
        ]);
        expect(result.verdict).toBe("inconclusive");
        expect(result.coverage).toBe("partial");
    });

    it("returns not_found only for complete successful negative coverage", () => {
        const input = { citation: "No such scholarly work" };
        const complete = aggregate(input, [outcome("crossref", "no_data"), outcome("semantic_scholar", "no_data")]);
        const partial = aggregate(input, [outcome("crossref", "no_data"), outcome("semantic_scholar", "unavailable")]);

        expect(complete).toMatchObject({ verdict: "not_found", coverage: "complete" });
        expect(partial).toMatchObject({ verdict: "inconclusive", coverage: "partial" });
    });

    it("keeps coverage partial when an unavailable source retained identifier evidence", () => {
        const input = { citation: "10.1000/example" };
        const result = aggregate(input, [
            {
                ...outcome("doi_registry", "unavailable", [record("doi_registry", "10.1000/example", { identifiers: { doi: "10.1000/example" } })]),
                identifierEvidence: { type: "doi", identifier: "10.1000/example", exists: true, metadataAvailable: false },
            },
        ]);

        expect(result).toMatchObject({ verdict: "verified", coverage: "partial" });
    });

    it("uses unverifiable only for an explicit unsupported work kind", () => {
        const result = aggregate({ citation: "Jones, personal communication" }, [
            outcome("crossref", "not_applicable"),
            outcome("semantic_scholar", "not_applicable"),
        ]);
        expect(result).toMatchObject({ verdict: "unverifiable", coverage: "none" });
    });

    it("reports field-level matches and mismatches against every source value", () => {
        const input = { citation: "PMID: 12345678", title: "Example study", authors: ["Smith"], year: 2021, venue: "Nature Medicine" };
        const result = aggregate(input, [
            outcome("pubmed", "ok", [
                record("pubmed", "12345678", {
                    identifiers: { pmid: "12345678" },
                    title: "Example study",
                    authors: ["Jane Smith"],
                    year: 2021,
                    venue: "Nature Medicine",
                }),
            ]),
        ]);

        expect(result.comparisons.map(({ field, status }) => [field, status])).toEqual([
            ["title", "match"],
            ["authors", "match"],
            ["year", "match"],
            ["venue", "match"],
        ]);
        expect(result.verdict).toBe("verified");
    });
});
