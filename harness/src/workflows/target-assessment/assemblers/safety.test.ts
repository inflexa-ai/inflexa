import { describe, expect, it } from "bun:test";

import { DerivedSchema } from "../../../contracts/target-dossier.js";
import { SafetyTargetSchema } from "../../../data/safety-panel-schema.js";
import { computeDerivedFields } from "../lib/compute-derived.js";
import type { Phase2Bundle } from "../steps/phase2-aggregate.js";
import type { Phase3Bundle } from "../steps/phase3-aggregate.js";
import { aggregateOffTargetPanel, buildOrganRollup, type OffTargetPanelRows } from "./safety.js";

type Fanout = Phase3Bundle["fanout"];

/** A Phase-2 bundle carrying only what the off-target panel assembler reads. */
function phase2With(targetChemblId: string): Phase2Bundle {
    return {
        phase1: {
            collectors: {
                chemblModulators: { coverage: "available", data: { targetChemblId, modulators: [] } },
            },
        },
        decisions: {},
    } as unknown as Phase2Bundle;
}

function polypharmFanout(hit: { targetChemblId: string; targetName: string; assayChemblId: string | null; pchemblValue: number }): Fanout {
    return {
        perModulatorPolypharm: {
            results: [
                {
                    coverage: "available",
                    data: {
                        moleculeChemblId: "CHEMBL1201585",
                        preferredName: "a modulator",
                        primaryPchembl: 9,
                        hits: [
                            {
                                targetChemblId: hit.targetChemblId,
                                targetName: hit.targetName,
                                assayChemblId: hit.assayChemblId,
                                pchemblValue: hit.pchemblValue,
                                standardType: "IC50",
                                standardValue: 12,
                                standardUnits: "nM",
                            },
                        ],
                    },
                },
            ],
        },
    } as unknown as Fanout;
}

describe("aggregateOffTargetPanel evidence", () => {
    it("locates a binding claim by the assay it was measured in", () => {
        const panel = aggregateOffTargetPanel(
            phase2With("CHEMBL1111"),
            polypharmFanout({ targetChemblId: "CHEMBL2222", targetName: "Kinase X", assayChemblId: "CHEMBL3705899", pchemblValue: 7.5 }),
            "P00519",
        );

        expect(panel).not.toBeNull();
        const row = panel!.rows[0]!;
        expect(row.support.state).toBe("scored");
        if (row.support.state !== "scored") return;
        const accessions = row.support.evidence.map((e) => e.accession);
        expect(accessions).toEqual(["CHEMBL3705899"]);
        // The off-target's own id names the protein, not the measurement.
        expect(accessions).not.toContain(row.off_target_id);
    });

    it("states it has no citable binding record when ChEMBL named no assay", () => {
        const panel = aggregateOffTargetPanel(
            phase2With("CHEMBL1111"),
            polypharmFanout({ targetChemblId: "CHEMBL2222", targetName: "Kinase X", assayChemblId: null, pchemblValue: 7.5 }),
            "P00519",
        );

        expect(panel).not.toBeNull();
        const row = panel!.rows[0]!;
        expect(row.support.state).toBe("unknown");
        if (row.support.state !== "unknown") return;
        expect(row.support.reason).toContain("no citable binding record");
    });
});

describe("organ rollup over the canonical vocabulary", () => {
    /**
     * The panel's organ enum and the rollup are the same vocabulary, so a panel
     * entry keyed to any canonical token produces a rollup row and the derived
     * completeness invariant holds.
     */
    it("does not fail an assessment for a panel organ outside the rollup's historical set", () => {
        const entry = SafetyTargetSchema.parse({
            chembl_id: "CHEMBL2222",
            gene_symbol: "RHO",
            uniprot: "P08100",
            name: "Rhodopsin",
            organ_system: "ocular",
            clinical_consequence: "visual disturbance",
            severity: "medium",
            references: ["PMID:12345678"],
        });

        const offTarget: OffTargetPanelRows = [
            {
                off_target_id: entry.chembl_id,
                off_target_name: entry.name,
                pchembl: 7.5,
                is_safety_panel_target: true,
                organ_system: entry.organ_system,
                support: { state: "unknown", reason: "no citable binding record" },
                relationship: "off_target",
            },
        ];

        const rollup = buildOrganRollup(null, null, offTarget, null);
        expect(rollup).not.toBeNull();
        expect(rollup!.map((r) => r.organ)).toEqual(["ocular"]);
        // The row carries the signal that produced it rather than standing in
        // for an organ the rollup could not reach.
        expect(rollup![0]!.signals.chembl_polypharm_count).toBe(1);
        expect(rollup![0]!.signal_type_count).toBe(1);
        expect(rollup![0]!.evidence.length).toBeGreaterThan(0);

        const derived = computeDerivedFields({
            safety_profile: {
                off_target_panel: { coverage: "available", data: { rows: offTarget } },
                organ_rollup: { coverage: "available", data: { rows: rollup } },
            },
        });
        expect(derived.organ_rollup_completeness.expected_organs).toEqual(["ocular"]);
        expect(derived.organ_rollup_completeness.missing_organs).toEqual([]);
        expect(DerivedSchema.safeParse(derived).success).toBe(true);
    });

    it("rolls up a trial adverse event onto the peripheral nervous system", () => {
        const trialAes = {
            serious: [{ term: "Peripheral neuropathy", organ: "Nervous system disorders", incidence_pct: 4, nct_ids: ["NCT00000001"] }],
        } as unknown as Parameters<typeof buildOrganRollup>[1];

        const rollup = buildOrganRollup(null, trialAes, null, null);
        expect(rollup!.map((r) => r.organ)).toEqual(["pns"]);
    });
});
