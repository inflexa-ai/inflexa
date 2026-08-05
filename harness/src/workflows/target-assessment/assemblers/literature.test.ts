import { describe, expect, it } from "bun:test";

import { DiscoveryTrialsSchema } from "../../../contracts/target-dossier.js";
import type { Phase2Bundle } from "../steps/phase2-aggregate.js";
import { assembleDiscoveryTrials, type AttributionContext } from "./literature.js";

type CtgovTrial = {
    nctId: string;
    title: string;
    phase: string;
    status: string;
    conditions: string[];
    interventions: string[];
    startDate: string | null;
    primaryCompletionDate: string | null;
};

function trial(nctId: string, title: string, interventions: string[], conditions: string[] = ["type 2 diabetes mellitus"]): CtgovTrial {
    return {
        nctId,
        title,
        phase: "PHASE2",
        status: "COMPLETED",
        conditions,
        interventions,
        startDate: "2019-01-01",
        primaryCompletionDate: "2021-01-01",
    };
}

/** A Phase-2 bundle carrying only the CT.gov collector the assembler reads. */
function phase2With(active: CtgovTrial[]): Phase2Bundle {
    return {
        phase1: { collectors: { ctgov: { coverage: "available", data: { active, failed: [] } } } },
        decisions: {},
    } as unknown as Phase2Bundle;
}

const attrCtx: AttributionContext = {
    assessmentUniprot: "P43220",
    assessmentSymbol: "GLP1R",
    familyUniprots: [],
    // CT.gov carries intervention names, not ChEMBL ids, so nothing to resolve.
    drugTargetResolver: async () => [],
};

/** Stand-in for the orchestrator's attribution pass, keyed by NCT id. */
function attributionFor(eligibleNctIds: Set<string>) {
    return <T extends { nct_id: string }>(row: T) => ({
        ...row,
        attribution: {
            relationship: eligibleNctIds.has(row.nct_id) ? ("class_modulator" as const) : ("unrelated" as const),
            evidence_role: eligibleNctIds.has(row.nct_id) ? ("supports_target" as const) : ("excluded" as const),
            basis: [{ kind: "known_class_drug" as const, source: "chembl" }],
            resolved_interventions: [],
        },
        eligible_for_toxicology_aggregation: eligibleNctIds.has(row.nct_id),
    });
}

const KNOWN_CLASS_DRUGS = new Set(["SEMAGLUTIDE"]);

describe("assembleDiscoveryTrials coverage", () => {
    it("reports filtered, not an empty available, when every candidate was dropped by relevance", async () => {
        // Neither trial names the symbol or a class drug, so both fall to a
        // low-confidence condition match — a filter of ours, not an empty source.
        const section = await assembleDiscoveryTrials(
            phase2With([trial("NCT001", "A study of empagliflozin", ["Empagliflozin"]), trial("NCT002", "A study of metformin", ["Metformin"])]),
            "GLP1R",
            attrCtx,
            KNOWN_CLASS_DRUGS,
            attributionFor(new Set()),
        );

        expect(section.coverage).toBe("filtered");
        expect(section).toMatchObject({ dropped_count: 2 });
        expect("data" in section).toBe(false);
        expect(DiscoveryTrialsSchema.safeParse(section).success).toBe(true);
    });

    it("reports filtered when every surviving candidate was excluded by attribution", async () => {
        const section = await assembleDiscoveryTrials(
            phase2With([trial("NCT001", "A study of semaglutide", ["Semaglutide"])]),
            "GLP1R",
            attrCtx,
            KNOWN_CLASS_DRUGS,
            attributionFor(new Set()),
        );

        expect(section).toMatchObject({ coverage: "filtered", dropped_count: 1 });
    });

    it("keeps a partially filtered section available and makes it report its drops", async () => {
        const section = await assembleDiscoveryTrials(
            phase2With([trial("NCT001", "A study of semaglutide", ["Semaglutide"]), trial("NCT002", "A study of metformin", ["Metformin"])]),
            "GLP1R",
            attrCtx,
            KNOWN_CLASS_DRUGS,
            attributionFor(new Set(["NCT001"])),
        );

        expect(section.coverage).toBe("available");
        expect(section).toMatchObject({ dropped_count: 1 });
        if (section.coverage !== "available") throw new Error("expected an available section");
        expect(section.data.rows.map((r) => r.nct_id)).toEqual(["NCT001"]);
        expect(DiscoveryTrialsSchema.safeParse(section).success).toBe(true);
    });

    it("reports queried_no_data when CT.gov held nothing left to discover", async () => {
        // The one trial names the symbol, so clinical_development.trials already
        // carries it and no candidate reaches this section at all.
        const section = await assembleDiscoveryTrials(
            phase2With([trial("NCT001", "A study of a GLP1R agonist", ["GLP1R agonist"])]),
            "GLP1R",
            attrCtx,
            KNOWN_CLASS_DRUGS,
            attributionFor(new Set(["NCT001"])),
        );

        expect(section.coverage).toBe("queried_no_data");
    });

    it("reports queried_no_data when CT.gov was never answered", async () => {
        const section = await assembleDiscoveryTrials(
            { phase1: { collectors: { ctgov: { coverage: "queried_no_data" } } }, decisions: {} } as unknown as Phase2Bundle,
            "GLP1R",
            attrCtx,
            KNOWN_CLASS_DRUGS,
            attributionFor(new Set()),
        );

        expect(section.coverage).toBe("queried_no_data");
    });
});
