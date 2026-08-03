/**
 * Opt-in live citation-authority contracts.
 *
 * Set CITATION_RESOLUTION_LIVE to run these cases against public upstreams.
 * They stay in the normal `bun test` suite and skip as one block when that
 * network precondition is absent.
 */

import { describe, expect, it } from "bun:test";

import { createCitationResolver, type CitationResolverConfig } from "../../citations/resolve.js";
import type { CitationSource } from "../../citations/types.js";

const LIVE = process.env.CITATION_RESOLUTION_LIVE;
const SOURCES: readonly CitationSource[] = ["doi_registry", "crossref", "pubmed", "arxiv", "semantic_scholar"];

function liveResolver(enabled: readonly CitationSource[]) {
    const enabledSet = new Set(enabled);
    const sources = Object.fromEntries(
        SOURCES.map((source) => [
            source,
            {
                enabled: enabledSet.has(source),
                maxRetries: 1,
                maxRetryDelayMs: 1_000,
            },
        ]),
    ) as NonNullable<CitationResolverConfig["sources"]>;
    return createCitationResolver({
        timeoutMs: 15_000,
        sources,
        ...(process.env.CROSSREF_MAILTO ? { crossref: { mailto: process.env.CROSSREF_MAILTO } } : {}),
        ...(process.env.NCBI_API_KEY ? { ncbiApiKey: process.env.NCBI_API_KEY } : {}),
    });
}

describe.skipIf(!LIVE)("live citation resolution", () => {
    it("resolves a canonical Crossref DOI through the DOI registry and Crossref", async () => {
        const result = await liveResolver(["doi_registry", "crossref"]).resolveOne({ citation: "10.1038/s41586-020-2649-2" });
        const registry = result.sourceOutcomes.find((outcome) => outcome.source === "doi_registry")!;
        const crossref = result.sourceOutcomes.find((outcome) => outcome.source === "crossref")!;

        expect(registry.identifierEvidence).toMatchObject({ exists: true, registrationAgency: "Crossref" });
        expect(crossref.status).toBe("ok");
        expect(crossref.records.some((record) => record.identifiers.doi === "10.1038/s41586-020-2649-2")).toBe(true);
        expect(result.verdict).toBe("verified");
    }, 45_000);

    it("verifies a DOI owned by a non-Crossref registration agency", async () => {
        const result = await liveResolver(["doi_registry", "crossref"]).resolveOne({ citation: "10.5240/B1FA-0EEC-C316-3316-3A73-L" });
        const registry = result.sourceOutcomes.find((outcome) => outcome.source === "doi_registry")!;
        const crossref = result.sourceOutcomes.find((outcome) => outcome.source === "crossref")!;

        expect(registry.identifierEvidence?.exists).toBe(true);
        expect(registry.identifierEvidence?.registrationAgency?.toLowerCase()).not.toBe("crossref");
        expect(crossref).toMatchObject({ status: "not_applicable", requestCount: 0 });
        expect(result.verdict).not.toBe("not_found");
    }, 45_000);

    it("retrieves a canonical PMID", async () => {
        const result = await liveResolver(["pubmed"]).resolveOne({ citation: "PMID: 22745249" });
        const pubmed = result.sourceOutcomes.find((outcome) => outcome.source === "pubmed")!;

        expect(pubmed.status).toBe("ok");
        expect(pubmed.records.some((record) => record.identifiers.pmid === "22745249")).toBe(true);
        expect(result.verdict).toBe("verified");
    }, 45_000);

    it("retrieves a canonical arXiv identifier", async () => {
        const result = await liveResolver(["arxiv"]).resolveOne({ citation: "arXiv:1706.03762" });
        const arxiv = result.sourceOutcomes.find((outcome) => outcome.source === "arxiv")!;

        expect(arxiv.status).toBe("ok");
        expect(arxiv.records.some((record) => record.identifiers.arxiv === "1706.03762")).toBe(true);
        expect(result.verdict).toBe("verified");
    }, 45_000);

    it("matches a raw bibliographic citation with bounded Crossref search", async () => {
        const result = await liveResolver(["crossref"]).resolveOne({
            citation: "Hanahan D, Weinberg RA. The Hallmarks of Cancer. Cell. 2000.",
            title: "The Hallmarks of Cancer",
            authors: ["Douglas Hanahan", "Robert A. Weinberg"],
            year: 2000,
            venue: "Cell",
        });
        const crossref = result.sourceOutcomes.find((outcome) => outcome.source === "crossref")!;

        expect(crossref.status).toBe("ok");
        expect(crossref.records.some((record) => record.title?.toLowerCase().includes("hallmarks of cancer"))).toBe(true);
        expect(result.verdict).not.toBe("not_found");
    }, 45_000);
});
