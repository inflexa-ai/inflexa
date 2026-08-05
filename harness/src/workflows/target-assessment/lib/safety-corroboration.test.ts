import { describe, expect, it } from "bun:test";

import { SafetyCorroborationSchema } from "../../../contracts/target-dossier.js";
import type { Phase1Bundle, ResolvedTarget } from "../schemas.js";
import type { OrganSignalProjection } from "./fda-label-safety.js";
import { resolveHpoOrgan } from "./hpo-organ-map.js";
import { assembleSafetyCorroboration, CORROBORATION_FILTER, MIN_INDEPENDENT_SOURCES, type CorroborationInput } from "./safety-corroboration.js";

const resolved: ResolvedTarget = {
    assessmentId: "00000000-0000-0000-0000-000000000000",
    goal: null,
    canonicalId: "HGNC:1097",
    canonicalOntology: "hgnc",
    geneSymbol: "BRAF",
    approvedName: "B-Raf proto-oncogene",
    ids: { hgnc: "HGNC:1097", ensembl: "ENSG00000157764", uniprot: "P15056", chembl: "CHEMBL5145", entrez: "673" },
    synonyms: [],
    proteinSynonyms: [],
    proteinFamily: null,
    resolutionCoverage: { hgnc: true, uniprot: true, ensembl: true, chembl: true },
};

const notLoaded = { coverage: "not_loaded" as const, reason: "test" };

function phase1(overrides: Partial<Phase1Bundle["collectors"]> = {}): Phase1Bundle {
    return {
        resolved,
        collectors: {
            opentargets: notLoaded,
            chemblModulators: notLoaded,
            ctgov: notLoaded,
            faersByTarget: notLoaded,
            expressionHuman: notLoaded,
            expressionMultiSpecies: notLoaded,
            clinvar: notLoaded,
            cbioportal: notLoaded,
            impc: notLoaded,
            pubmedIndex: notLoaded,
            pathways: notLoaded,
            stringPpi: notLoaded,
            familyComplexes: notLoaded,
            monarch: notLoaded,
            therapeuticPrograms: notLoaded,
            ...overrides,
        },
    } as Phase1Bundle;
}

function labelSignals(organs: Array<{ organ: string; excerpt: string }>): OrganSignalProjection {
    return {
        dropped_count: 0,
        signals: organs.map(({ organ, excerpt }) => ({
            organ: organ as OrganSignalProjection["signals"][number]["organ"],
            drug_name: "vemurafenib",
            application_number: "NDA202429",
            source_section: "warnings_and_precautions" as const,
            label_section: "5.1",
            excerpt,
            evidence: {
                source: "openfda:label",
                predicate: "label_warning",
                excerpt,
                regulatory_reference: { document: "FDA prescribing information — vemurafenib", section: "5.1", doc_id: "NDA202429" },
            },
        })),
    };
}

function impcAvailable(organSystems: string[], mgiAccessionId: string | null = "MGI:88190") {
    return {
        coverage: "available" as const,
        data: {
            mouseMarkerSymbol: "Braf",
            mgiAccessionId,
            viability: "viable" as const,
            viabilityCalls: [],
            mpTerms: [],
            organSystems,
            sexDimorphic: false,
            phenotypeCount: 12,
        },
    };
}

function monarchAvailable(phenotypes: Array<{ hpoId: string; label: string; ancestorIds: string[]; publications?: string[] }>) {
    return {
        coverage: "available" as const,
        data: {
            geneCurie: "HGNC:1097",
            phenotypes: phenotypes.map((p) => ({
                hpoId: p.hpoId,
                label: p.label,
                ancestorIds: p.ancestorIds,
                publications: p.publications ?? [],
                diseaseContext: null,
                frequencyPercent: null,
                primaryKnowledgeSource: "infores:hpo-annotations",
            })),
        },
    };
}

function run(input: Partial<CorroborationInput> & { phase1: Phase1Bundle }) {
    const section = assembleSafetyCorroboration({
        regulatoryOrganSignals: null,
        ...input,
    });
    // The fold's output is the dossier's contract, so every case asserts through it.
    expect(SafetyCorroborationSchema.safeParse(section).success).toBe(true);
    return section;
}

describe("resolveHpoOrgan", () => {
    it("resolves a term by an organ-system ancestor", () => {
        expect(resolveHpoOrgan("HP:0002910", ["HP:0001392", "HP:0025031", "HP:0000118"])).toBe("hepatic");
    });

    it("prefers the more specific ancestor over the broad one", () => {
        // A liver phenotype's closure also carries the digestive-system root.
        expect(resolveHpoOrgan("HP:0001394", ["HP:0025031", "HP:0001392"])).toBe("hepatic");
    });

    it("returns null when nothing in the ancestry denotes a canonical organ", () => {
        expect(resolveHpoOrgan("HP:0000407", ["HP:0000598", "HP:0000118"])).toBeNull();
    });

    it("resolves a term by its own id", () => {
        expect(resolveHpoOrgan("HP:0001392", [])).toBe("hepatic");
    });

    it("resolves a neoplasm through the organ root it sits under", () => {
        // Lung neoplasm: malignant, and respiratory wherever it is filed, so it
        // can corroborate a respiratory finding from another source.
        expect(resolveHpoOrgan("HP:0100526", ["HP:0002664", "HP:0002086", "HP:0000118"])).toBe("respiratory");
        expect(resolveHpoOrgan("HP:0002896", ["HP:0002664", "HP:0001392", "HP:0000118"])).toBe("hepatic");
    });

    it("returns null for a neoplasm that names no organ", () => {
        expect(resolveHpoOrgan("HP:0002664", [])).toBeNull();
    });

    it("resolves the thyroid root but not the endocrine root above it", () => {
        expect(resolveHpoOrgan("HP:0000821", ["HP:0000820", "HP:0000818"])).toBe("endocrine_thyroid");
        // Adrenal insufficiency is endocrine, and no canonical token names it.
        expect(resolveHpoOrgan("HP:0000846", ["HP:0000818", "HP:0000118"])).toBeNull();
    });
});

describe("assembleSafetyCorroboration", () => {
    it("reports an organ carried by several independent sources", () => {
        const section = run({
            phase1: phase1({
                impc: impcAvailable(["hepatic"]),
                monarch: monarchAvailable([
                    { hpoId: "HP:0002910", label: "Elevated transaminase", ancestorIds: ["HP:0001392"], publications: ["PMID:12345678"] },
                ]),
            }),
            regulatoryOrganSignals: labelSignals([{ organ: "hepatic", excerpt: "Hepatotoxicity: transaminase elevations have been observed." }]),
        });

        expect(section.coverage).toBe("available");
        if (section.coverage !== "available") return;
        expect(section.data.rows).toHaveLength(1);
        const row = section.data.rows[0]!;
        expect(row.organ).toBe("hepatic");
        expect(row.corroborating_sources).toEqual(["fda_label", "impc", "monarch"]);
        expect(row.independent_source_count).toBe(3);
        expect(row.contributions).toHaveLength(3);
        expect(section.data.min_independent_sources).toBe(MIN_INDEPENDENT_SOURCES);
        expect(section.data.sources_considered).toEqual(["fda_label", "impc", "monarch"]);
    });

    it("carries the contributions' evidence as the claim's evidence", () => {
        const section = run({
            phase1: phase1({
                impc: impcAvailable(["cardiovascular"]),
                monarch: monarchAvailable([{ hpoId: "HP:0001635", label: "Congestive heart failure", ancestorIds: ["HP:0001626"] }]),
            }),
        });

        expect(section.coverage).toBe("available");
        if (section.coverage !== "available") return;
        const row = section.data.rows[0]!;
        expect(row.support.state).toBe("scored");
        if (row.support.state !== "scored") return;
        expect(row.support.evidence).toHaveLength(2);
        // Every claim evidence item resolves to a record a reader can check.
        for (const e of row.support.evidence) {
            expect(Boolean(e.pmid ?? e.doi ?? e.accession ?? e.regulatory_reference)).toBe(true);
        }
        expect(row.support.evidence.map((e) => e.accession)).toContain("MGI:88190");
    });

    it("counts one source's several signals for an organ once", () => {
        const section = run({
            phase1: phase1({ impc: impcAvailable(["hepatic"]) }),
            regulatoryOrganSignals: labelSignals([
                { organ: "hepatic", excerpt: "Hepatotoxicity: transaminase elevations have been observed." },
                { organ: "hepatic", excerpt: "Hepatic failure, including fatal cases, has been reported." },
            ]),
        });

        expect(section.coverage).toBe("available");
        if (section.coverage !== "available") return;
        const row = section.data.rows[0]!;
        expect(row.contributions).toHaveLength(3);
        expect(row.independent_source_count).toBe(2);
    });

    it("drops a single-source organ and counts its signals", () => {
        const section = run({
            phase1: phase1({ impc: impcAvailable(["hepatic", "renal"]) }),
            regulatoryOrganSignals: labelSignals([{ organ: "hepatic", excerpt: "Hepatotoxicity has been observed." }]),
        });

        expect(section.coverage).toBe("available");
        if (section.coverage !== "available") return;
        expect(section.data.rows.map((r) => r.organ)).toEqual(["hepatic"]);
        // The renal knockout signal stood alone.
        expect(section.dropped_count).toBe(1);
    });

    it("reports filtered with a real dropped count when nothing corroborates", () => {
        const section = run({
            phase1: phase1({ impc: impcAvailable(["hepatic", "renal"]) }),
        });

        expect(section.coverage).toBe("filtered");
        if (section.coverage !== "filtered") return;
        expect(section.dropped_count).toBe(2);
        expect(section.filter).toBe(CORROBORATION_FILTER);
    });

    it("never reports an emptied fold as no data — a signal that arrived is either kept or counted", () => {
        // Every one of these leaves the fold with no row: an organ that does not
        // resolve, a source standing alone, both at once. None may come back as
        // "the sources held nothing", because in each case they held something.
        for (const impcOrgans of [["hepatic"], ["hearing"], ["hepatic", "renal"], ["hearing", "vision"]]) {
            const section = run({ phase1: phase1({ impc: impcAvailable(impcOrgans) }) });
            expect({ impcOrgans, coverage: section.coverage }).toEqual({ impcOrgans, coverage: "filtered" });
            if (section.coverage !== "filtered") continue;
            expect(section.dropped_count).toBeGreaterThan(0);
        }
    });

    it("drops a signal whose organ does not resolve", () => {
        const section = run({
            phase1: phase1({
                impc: impcAvailable(["hepatic", "hearing"]),
                monarch: monarchAvailable([{ hpoId: "HP:0002910", label: "Elevated transaminase", ancestorIds: ["HP:0001392"] }]),
            }),
        });

        expect(section.coverage).toBe("available");
        if (section.coverage !== "available") return;
        expect(section.data.rows.map((r) => r.organ)).toEqual(["hepatic"]);
        expect(section.dropped_count).toBe(1);
    });

    it("does not corroborate an organ neither source named", () => {
        // A mouse endocrine/exocrine gland knockout and a human adrenal
        // phenotype are both endocrine and neither is thyroid, so nothing here
        // reaches the one endocrine token.
        const section = run({
            phase1: phase1({
                impc: impcAvailable(["endocrine"]),
                monarch: monarchAvailable([{ hpoId: "HP:0000846", label: "Adrenal insufficiency", ancestorIds: ["HP:0000818", "HP:0000118"] }]),
            }),
        });

        expect(section.coverage).toBe("filtered");
        if (section.coverage !== "filtered") return;
        expect(section.dropped_count).toBe(2);
    });

    it("corroborates a respiratory neoplasm against a respiratory label warning", () => {
        const section = run({
            phase1: phase1({
                monarch: monarchAvailable([{ hpoId: "HP:0100526", label: "Neoplasm of the lung", ancestorIds: ["HP:0002664", "HP:0002086"] }]),
            }),
            regulatoryOrganSignals: labelSignals([{ organ: "respiratory", excerpt: "Pulmonary toxicity has been reported." }]),
        });

        expect(section.coverage).toBe("available");
        if (section.coverage !== "available") return;
        expect(section.data.rows.map((r) => r.organ)).toEqual(["respiratory"]);
        expect(section.data.rows[0]!.independent_source_count).toBe(2);
    });

    it("drops a signal whose source produced no locator", () => {
        const section = run({
            phase1: phase1({
                impc: impcAvailable(["hepatic"], null),
                monarch: monarchAvailable([{ hpoId: "HP:0002910", label: "Elevated transaminase", ancestorIds: ["HP:0001392"] }]),
            }),
        });

        expect(section.coverage).toBe("filtered");
        if (section.coverage !== "filtered") return;
        // The knockout signal had no accession; the surviving hepatic phenotype
        // then stood alone and fell below the corroboration threshold.
        expect(section.dropped_count).toBe(2);
    });

    it("reports queried_no_data when no source produced a signal", () => {
        const section = run({ phase1: phase1() });
        expect(section.coverage).toBe("queried_no_data");
    });

    it("proceeds with the remaining sources when one is unavailable", () => {
        const section = run({
            phase1: phase1({
                impc: { coverage: "queried_no_data", error: { message: "IMPC has no mouse marker" } },
                monarch: monarchAvailable([{ hpoId: "HP:0002910", label: "Elevated transaminase", ancestorIds: ["HP:0001392"] }]),
            }),
            regulatoryOrganSignals: labelSignals([{ organ: "hepatic", excerpt: "Hepatotoxicity has been observed." }]),
        });

        expect(section.coverage).toBe("available");
        if (section.coverage !== "available") return;
        expect(section.data.sources_considered).toEqual(["fda_label", "monarch"]);
    });

    it("admits a source that did not exist when the fold was written", () => {
        // The contributing set is open: a record naming its own source flows
        // through grouping, counting, and evidence assembly untouched, so this
        // asserts the schema accepts a source id the fold has never seen.
        const section = SafetyCorroborationSchema.safeParse({
            coverage: "available",
            data: {
                rows: [
                    {
                        organ: "hepatic",
                        contributions: [
                            { source: "fda_label", signal: "Hepatotoxicity", evidence: { source: "openfda:label", accession: "NDA202429" } },
                            { source: "a-source-added-later", signal: "hepatic finding", evidence: { source: "later", accession: "X:1" } },
                        ],
                        corroborating_sources: ["a-source-added-later", "fda_label"],
                        independent_source_count: 2,
                        support: {
                            state: "scored",
                            evidence: [
                                { source: "openfda:label", accession: "NDA202429" },
                                { source: "later", accession: "X:1" },
                            ],
                        },
                    },
                ],
                sources_considered: ["a-source-added-later", "fda_label"],
                min_independent_sources: 2,
            },
        });
        expect(section.success).toBe(true);
    });
});
