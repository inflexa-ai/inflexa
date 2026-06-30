/**
 * Trial-attribution classifier + UniProt-backed identity resolvers.
 *
 * `resolveOnTargetChemblIds` and `resolveFamilySiblingUniprots` replace the
 * hand-curated ALTERNATE_CHEMBL_IDS and RELATED_FAMILY_UNIPROTS maps that
 * previously lived here. Both fetch from authoritative sources at assembly
 * time (UniProt for ChEMBL cross-references; IUPHAR Guide to Pharmacology
 * for receptor-family siblings) so no per-target editing is needed when a
 * new HGNC target is assessed.
 *
 * The actual loop-level checks (`isOnTargetChemblId` etc.) take the
 * resolved arrays as plain inputs so the per-row assembly path stays
 * synchronous after a single upfront await.
 */

import { withHost } from "../../../lib/host-concurrency.js";
import { getFamilySiblingUniprots } from "../../../tools/lib/iuphar-client.js";
import { getChemblIdsByUniProt } from "../../../tools/lib/uniprot-client.js";

export type TrialAttributionInput = {
    assessmentUniprot: string;
    /** UniProts of related family receptors (resolved from IUPHAR family siblings). */
    familyUniprots: string[];
    interventions: Array<{ drugChemblId: string | null; name: string }>;
    conditions: string[];
    drugTargetResolver: (chemblId: string) => Promise<string[]>;
};

export type TrialAttributionResult = {
    match_confidence: "high" | "low" | "off_target";
    intervention_target_uniprots: string[];
    related_target_uniprots: string[];
};

/**
 * Classify how strongly a trial pertains to the assessment target based on
 * the intervention drug's mechanism target.
 */
export async function classifyTrialAttribution(input: TrialAttributionInput): Promise<TrialAttributionResult> {
    const interventionTargets = new Set<string>();
    for (const iv of input.interventions) {
        if (!iv.drugChemblId) continue;
        const accs = await input.drugTargetResolver(iv.drugChemblId);
        for (const a of accs) interventionTargets.add(a);
    }

    const intervention_target_uniprots = [...interventionTargets];
    const hitsAssessment = interventionTargets.has(input.assessmentUniprot);
    const related_target_uniprots = [...interventionTargets].filter((a) => input.familyUniprots.includes(a) && a !== input.assessmentUniprot);

    if (hitsAssessment) {
        return { match_confidence: "high", intervention_target_uniprots, related_target_uniprots };
    }
    if (related_target_uniprots.length > 0) {
        return { match_confidence: "off_target", intervention_target_uniprots, related_target_uniprots };
    }
    return { match_confidence: "low", intervention_target_uniprots, related_target_uniprots };
}

/**
 * Resolve every ChEMBL target id that UniProt links to the given accession.
 * The result is used as a positive list for on-target self-hit detection —
 * a polypharm row whose off_target_id is in this list is the assessment
 * target itself (alternate ChEMBL entry), not an off-target liability.
 *
 * Returns [] when the accession is missing or UniProt has no ChEMBL xrefs.
 * Network failures are surfaced as an empty list so the assembler degrades
 * to "no alternate-id filtering" rather than blocking the run.
 */
export async function resolveOnTargetChemblIds(assessmentUniprot: string): Promise<string[]> {
    if (!assessmentUniprot) return [];
    try {
        return await withHost("uniprot", () => getChemblIdsByUniProt(assessmentUniprot));
    } catch {
        return [];
    }
}

/**
 * Resolve UniProt accessions of sibling receptors in the same IUPHAR family
 * as the assessment target. Used by `classifyTrialAttribution` so a trial
 * whose intervention hits a paralog (e.g., CALCRL when CALCR is the
 * assessment target) lands in `related_target_trials[]` rather than the
 * primary trials list.
 */
export async function resolveFamilySiblingUniprots(uniprotOrGeneSymbol: string): Promise<string[]> {
    if (!uniprotOrGeneSymbol) return [];
    try {
        return await withHost("iuphar", () => getFamilySiblingUniprots(uniprotOrGeneSymbol));
    } catch {
        return [];
    }
}

/**
 * Returns true if `chemblId` is among the supplied list of on-target ChEMBL
 * ids for the assessment protein. Caller is responsible for resolving the
 * list once via `resolveOnTargetChemblIds` and reusing it across rows.
 */
export function isOnTargetChemblId(chemblId: string, onTargetChemblIds: string[]): boolean {
    return onTargetChemblIds.includes(chemblId);
}
