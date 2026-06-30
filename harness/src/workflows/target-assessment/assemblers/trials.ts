import type {
    DossierV4Body,
    Entity,
    TractabilitySection,
    EvidenceItem,
    TractabilityV4Section,
    RegulatoryActionRow,
} from "@inflexa-ai/harness/contracts/target-dossier.js";
import { expectedOrgansFromBody } from "../lib/compute-derived.js";
import type { Phase2Bundle } from "../steps/phase2-aggregate.js";
import type { Phase3Bundle } from "../steps/phase3-aggregate.js";
import type { ResolvedTarget } from "../schemas.js";
import { inferTherapeuticArea, getBenchmarks, getDatasetAttribution } from "../../../tools/lib/clinical-benchmarks-client.js";
import { inferModalityFromFamily } from "../../../tools/lib/protein-family-modality.js";
import { SafetyPanelFileSchema, type SafetyTarget } from "../../../data/safety-panel-schema.js";
import safetyPanelData from "../../../data/safety-panel.json" with { type: "json" };
import { classifyTrialAttribution, isOnTargetChemblId, resolveFamilySiblingUniprots, resolveOnTargetChemblIds } from "../lib/target-identity-filter.js";
import { isIntendedCoTarget } from "../lib/intended-polypharm-filter.js";
import { makeHeterodimerOfAssessmentFilter } from "../lib/heterodimer-filter.js";
import { buildFamilyComplexSupplement } from "../lib/family-complex-supplement.js";
import type { FamilyComplexesBundle } from "../schemas.js";
import { computeSelectivity } from "../lib/compute-selectivity.js";
import { getDrugPrimaryTargetUniprots } from "../../../tools/lib/chembl-client.js";
import type { Pool } from "pg";
import { annotateOffTargetPanel } from "../lib/clinical-consequence-annotator.js";
import type { ClinicalConsequenceAnnotatorDeps } from "../lib/clinical-consequence-annotator.js";
import { coverageFromRows } from "../coverage.js";
import { fetchRegulatoryActions } from "../lib/regulatory-actions.js";
import { classifyOrgan, classifyPolypharmOrgan, classifyTrialAe, type CanonicalOrgan } from "../lib/meddra-organ-map.js";
import { HIGH_EXPRESSION_TPM_THRESHOLD, CNS_REGION_TPM_FLOOR, MUSCULOSKELETAL_TPM_FLOOR } from "../lib/expression-constants.js";
export { HIGH_EXPRESSION_TPM_THRESHOLD };
import { resolveModulatorMoleculeType } from "../lib/dedup-modulators.js";
import type { ChemblModulator } from "../../../tools/lib/chembl-client.js";
import { searchFailedTrialsForDrugNames } from "../../../tools/lib/clinical-trials-client.js";

import type { AttributionContext } from "./literature.js";
import { partitionTrialsByAttribution, classifyRelevanceBasis } from "./literature.js";

type FanoutResults = Phase3Bundle["fanout"];

export type TrialOutcomeFilter = {
    /** Confidence level per NCT ID, as determined by partitionTrialsByAttribution. */
    attributionByNct: Map<string, "high" | "medium" | "low" | "off_target">;
    /** NCT IDs that are low-confidence and matched only via condition string — these are off-class contaminants. */
    lowConditionOnlyNcts: Set<string>;
};

export function aggregateTrialOutcomes(fanout: FanoutResults | undefined, filter: TrialOutcomeFilter | undefined) {
    if (!fanout) return null;
    const items = fanout.perTrialAes.results;
    const rows: Array<{
        nct_id: string;
        outcome_type: "primary" | "secondary" | "other";
        measure: string;
        description?: string;
        time_frame?: string;
        effect:
            | { kind: "quantitative"; value: number; units: string; ci_low?: number; ci_high?: number }
            | { kind: "not_extracted"; reason: "ctgov_no_numeric_result" | "ctgov_no_result_groups" };
    }> = [];
    for (const item of items) {
        if (item.coverage !== "available") continue;
        if (filter) {
            const conf = filter.attributionByNct.get(item.data.nctId);
            // Drop paralog/off-target trials entirely.
            if (conf === "off_target") continue;
            // Drop low-confidence trials whose only relevance basis is a generic condition string.
            if (conf === "low" && filter.lowConditionOnlyNcts.has(item.data.nctId)) continue;
            // Pass-through path: an NCT ID seen in the fanout but absent from the
            // attribution map. In normal operation the filter is built from the same
            // [active, failed] trial set the fanout iterates, so this branch should
            // never fire. We keep the row rather than drop silently so a future
            // upstream change that adds NCTs to the fanout without re-running
            // classification produces visible data rather than silent loss.
        }
        for (const o of item.data.outcomes ?? []) {
            const outcome_type = o.type === "primary" ? ("primary" as const) : o.type === "secondary" ? ("secondary" as const) : ("other" as const);
            rows.push({
                nct_id: item.data.nctId,
                outcome_type,
                measure: o.measure,
                description: o.description ?? undefined,
                time_frame: o.timeFrame ?? undefined,
                effect: o.effect,
            });
        }
    }
    rows.sort((a, b) => {
        const order = { primary: 0, secondary: 1, other: 2 } as const;
        return order[a.outcome_type] - order[b.outcome_type];
    });
    if (rows.length === 0) return null;
    return rows.slice(0, 200);
}

export async function buildTrialOutcomeFilter(
    phase2: Phase2Bundle,
    attrCtx: AttributionContext,
    knownClassDrugNames: Set<string>,
    symbol: string,
): Promise<TrialOutcomeFilter> {
    if (phase2.phase1.collectors.ctgov.coverage !== "available") {
        return { attributionByNct: new Map(), lowConditionOnlyNcts: new Set() };
    }
    const ctgov = phase2.phase1.collectors.ctgov;
    const allTrials = [...ctgov.data.active, ...ctgov.data.failed];
    const partitioned = await partitionTrialsByAttribution(allTrials, attrCtx);
    const attributionByNct = new Map<string, "high" | "medium" | "low" | "off_target">();
    for (const t of partitioned.primary) {
        attributionByNct.set(t.nctId, t.match_confidence);
    }
    for (const t of partitioned.related) {
        attributionByNct.set(t.nctId, "off_target");
    }
    // Collect NCT IDs that are low-confidence and matched only via a generic
    // condition string — these are wrong-class contaminants (e.g. an SGLT2
    // trial appearing in a GLP1R dossier because it shares a diabetes indication).
    const escapedSym = symbol.replace(/[-]/g, "[-\\s]?").replace(/\d+/, "\\d+");
    const titleKeywordRx = new RegExp(`\\b${escapedSym}\\b`, "i");
    const lowConditionOnlyNcts = new Set<string>(
        partitioned.primary
            .filter((t) => {
                if (t.match_confidence !== "low") return false;
                const basis = classifyRelevanceBasis(t, knownClassDrugNames, titleKeywordRx);
                return basis.kind === "condition_match";
            })
            .map((t) => t.nctId),
    );
    return { attributionByNct, lowConditionOnlyNcts };
}
