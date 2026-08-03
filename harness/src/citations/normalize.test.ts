import { describe, expect, it } from "bun:test";

import { authorNamesMatch, citationLookupKey, extractArxivId, extractDoi, extractPmid, normalizeAuthor, normalizeCitation } from "./normalize.js";
import { planCitationSources } from "./plan.js";
import { CitationInputSchema } from "./types.js";

describe("citation input and normalization", () => {
    it("parses an identifier-only input and preserves the original citation", () => {
        const input = CitationInputSchema.parse({ citation: "https://doi.org/10.1038/S41586-020-2649-2" });
        const normalized = normalizeCitation(input);

        expect(normalized).toMatchObject({
            citation: "https://doi.org/10.1038/S41586-020-2649-2",
            kind: "doi",
            identifiers: { doi: "10.1038/s41586-020-2649-2" },
            supplied: {},
        });
    });

    it("normalizes supplied fields without replacing their input values", () => {
        const input = CitationInputSchema.parse({
            citation: "Smith et al. Example study. 2021.",
            title: "  Example—Study ",
            authors: ["Smith, Jane Jr.", "DOE A."],
            year: 2021,
            venue: "Nature  Medicine",
            volume: " 12 ",
            firstPage: "e001",
        });

        expect(input.title).toBe("Example—Study");
        expect(normalizeCitation(input).supplied).toEqual({
            title: "example study",
            authors: ["smith jane", "doe a"],
            year: 2021,
            venue: "nature medicine",
            volume: "12",
            firstPage: "e001",
        });
    });

    it("extracts canonical DOI, PMID, and arXiv identifiers", () => {
        expect(extractDoi("doi:10.1000/ABC.123.")).toBe("10.1000/abc.123");
        expect(extractPmid("PMID: 12345678")).toBe("12345678");
        expect(extractArxivId("https://arxiv.org/abs/2401.01234v2")).toBe("2401.01234");
        expect(normalizeAuthor("García, María III")).toBe("garcía maría");
    });

    it("rejects malformed hinted identifiers", () => {
        expect(() => normalizeCitation({ citation: "not a doi", kind: "doi" })).toThrow("no valid DOI");
        expect(() => normalizeCitation({ citation: "PMID: abc", kind: "pmid" })).toThrow("no valid PMID");
        expect(() => normalizeCitation({ citation: "arXiv: unknown", kind: "arxiv" })).toThrow("no valid arXiv");
    });

    it("classifies only explicit unsupported work descriptions", () => {
        expect(normalizeCitation({ citation: "Jones, personal communication" }).unsupportedWorkKind).toBe("personal_communication");
        expect(normalizeCitation({ citation: "A normal paper no source found" }).unsupportedWorkKind).toBeUndefined();
    });

    it("keys an exact identifier by the lookup it provokes, not by supplied metadata", () => {
        expect(citationLookupKey({ citation: "DOI: 10.1000/ABC" })).toBe(citationLookupKey({ citation: "https://doi.org/10.1000/abc" }));
        expect(citationLookupKey({ citation: "10.1000/abc", title: "One title" })).toBe(citationLookupKey({ citation: "10.1000/abc", title: "Another" }));
    });

    it("keys a free-text citation by the metadata that dispatches its search", () => {
        expect(citationLookupKey({ citation: "A study", title: "One title" })).not.toBe(citationLookupKey({ citation: "A study", title: "Another" }));
    });
});

describe("author name matching", () => {
    it("accepts the same name however the citation style orders and abbreviates it", () => {
        expect(authorNamesMatch("Smith, Jane A.", "Jane A. Smith")).toBe(true);
        expect(authorNamesMatch("Smith J", "Jane Smith")).toBe(true);
        expect(authorNamesMatch("Smith JA", "Jane A Smith")).toBe(true);
        expect(authorNamesMatch("García, María III", "María García")).toBe(true);
        expect(authorNamesMatch("van der Berg, J", "Johan van der Berg")).toBe(true);
    });

    it("accepts a surname alone only where the other side adds nothing to contradict", () => {
        expect(authorNamesMatch("Smith", "Jane Smith")).toBe(true);
        expect(authorNamesMatch("Jane Smith", "Smith")).toBe(true);
    });

    it("rejects a different person behind a shared surname", () => {
        expect(authorNamesMatch("John Smith", "Jane Smith")).toBe(false);
        expect(authorNamesMatch("Smith J", "Adam Smith")).toBe(false);
        expect(authorNamesMatch("Smith, J.", "Smith, A.")).toBe(false);
        expect(authorNamesMatch("John Smith", "John Smithson")).toBe(false);
        expect(authorNamesMatch("Jane Wu", "Jane Li")).toBe(false);
        expect(authorNamesMatch("Jane Doe", "John Smith")).toBe(false);
    });
});

describe("citation source planner", () => {
    it("plans an exact DOI without assuming Crossref ownership", () => {
        const input = { citation: "10.5555/example" };
        const plan = planCitationSources(input, normalizeCitation(input));

        expect(plan.find((entry) => entry.source === "doi_registry")).toMatchObject({ applicable: true, operation: "doi_exact" });
        expect(plan.find((entry) => entry.source === "crossref")).toMatchObject({ applicable: true, operation: "crossref_doi_if_owned" });
    });

    it("does not fan a PMID into raw bibliographic searches", () => {
        const input = { citation: "PMID: 12345678" };
        const plan = planCitationSources(input, normalizeCitation(input));

        expect(plan.filter((entry) => entry.applicable).map((entry) => entry.source)).toEqual(["pubmed", "semantic_scholar"]);
        expect(plan.find((entry) => entry.source === "pubmed")?.operation).toBe("pubmed_exact");
    });

    it("uses ECitMatch only for a useful structured combination", () => {
        const raw = { citation: "Smith et al.", venue: "Nature" };
        expect(planCitationSources(raw, normalizeCitation(raw)).find((entry) => entry.source === "pubmed")?.applicable).toBe(false);

        const structured = { citation: "Smith et al.", venue: "Nature", year: 2021, volume: "12" };
        expect(planCitationSources(structured, normalizeCitation(structured)).find((entry) => entry.source === "pubmed")).toMatchObject({
            applicable: true,
            operation: "pubmed_structured",
            candidateGeneration: true,
        });
    });

    it("marks every authority not applicable for explicit unsupported work", () => {
        const input = { citation: "Jones, unpublished data" };
        expect(planCitationSources(input, normalizeCitation(input)).every((entry) => !entry.applicable && entry.operation === "none")).toBe(true);
    });
});
