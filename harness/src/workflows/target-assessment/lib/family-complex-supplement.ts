/**
 * Build the obligate-cofactor supplement rows shown in
 * OffTargetPanelV4.excluded_rows from the IUPHAR family-complexes collector
 * bundle. Replaces the hand-curated calcitonin-only supplement that
 * previously lived next to it.
 *
 * pchembl is set to 0 because IUPHAR exposes complex structure, not
 * ligand affinity for the complex; the row is marked selectivity_unknown
 * with an explicit reason so downstream readers see the obligate-cofactor
 * surface rather than a developable potency claim. The per-row LLM
 * clinical_consequence annotator populates `clinical_consequence` once
 * the per-row annotation step runs.
 */

import type { ExcludedOffTargetRowV4Schema } from "@inflexa-ai/harness/contracts/target-dossier.js";
import type { z } from "zod";
import type { FamilyComplexesBundle } from "../schemas.js";

type ExcludedOffTargetRowV4 = z.infer<typeof ExcludedOffTargetRowV4Schema>;

export function buildFamilyComplexSupplement(bundle: FamilyComplexesBundle): (Omit<ExcludedOffTargetRowV4, "evidence"> & { evidence: [] })[] {
    return bundle.complexes.map((c) => {
        const accDesc = c.accessoryNames.length > 0 ? c.accessoryNames.join("+") : "an accessory protein";
        return {
            off_target_id: null,
            off_target_name: c.complexName,
            target_class: "GPCR receptor-accessory complex",
            pchembl: 0,
            is_safety_panel_target: false,
            organ_system: null,
            clinical_consequence: null,
            selectivity: {
                selectivity_unknown: true as const,
                reason: "obligate cofactor (same primary protein, different accessory)",
            },
            selectivity_window_below_threshold: false,
            relationship: "obligate_cofactor" as const,
            reason:
                `${c.complexName} is ${bundle.primaryTargetGene} heterodimerised with ${accDesc}; ` +
                `selectivity is not pharmacologically attainable. Surfaced as an intrinsic-pharmacology ` +
                `liability rather than a developable off-target.`,
            evidence: [],
        };
    });
}
