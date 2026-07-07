/**
 * Phase-4 deterministic assemblers — safety sections.
 *
 * Each assembler maps Phase-1 / Phase-2 / Phase-3 outputs onto the
 * corresponding dossier section schema. Coverage is honored end-to-end:
 * when an upstream came back `queried_no_data` or the derived row set is
 * empty, the section is marked `queried_no_data` / `not_loaded` rather
 * than fabricated. Aggregate rows preserve their contributing evidence
 * under `evidence: [...]` arrays.
 */

import type { z } from "zod";
import type { EvidenceItem, RegulatoryActionRow, OffTargetRowV4Schema, ExcludedOffTargetRowV4Schema } from "@inflexa-ai/harness/contracts/target-dossier.js";
import { expectedOrgansFromBody } from "../lib/compute-derived.js";
import type { Phase2Bundle } from "../steps/phase2-aggregate.js";
import type { Phase3Bundle } from "../steps/phase3-aggregate.js";
import { inferTherapeuticArea } from "../../../tools/lib/clinical-benchmarks-client.js";
import { SafetyPanelFileSchema, type SafetyTarget } from "../../../data/safety-panel-schema.js";
import safetyPanelData from "../../../data/safety-panel.json" with { type: "json" };
import { isOnTargetChemblId } from "../lib/target-identity-filter.js";
import { isIntendedCoTarget } from "../lib/intended-polypharm-filter.js";
import { makeHeterodimerOfAssessmentFilter } from "../lib/heterodimer-filter.js";
import { buildFamilyComplexSupplement } from "../lib/family-complex-supplement.js";
import type { FamilyComplexesBundle } from "../schemas.js";
import { computeSelectivity } from "../lib/compute-selectivity.js";
import { classifyOrgan, classifyPolypharmOrgan, classifyTrialAe, type CanonicalOrgan } from "../lib/meddra-organ-map.js";
import { HIGH_EXPRESSION_TPM_THRESHOLD, CNS_REGION_TPM_FLOOR, MUSCULOSKELETAL_TPM_FLOOR } from "../lib/expression-constants.js";
export { HIGH_EXPRESSION_TPM_THRESHOLD };
import type { ChemblModulator } from "../../../tools/lib/chembl-client.js";

type OffTargetRowV4 = z.infer<typeof OffTargetRowV4Schema>;
type ExcludedOffTargetRowV4 = z.infer<typeof ExcludedOffTargetRowV4Schema>;

// ── Safety panel lookup ─────────────────────────────────────────────

const SAFETY_PANEL = SafetyPanelFileSchema.parse(safetyPanelData);
const SAFETY_BY_CHEMBL = new Map<string, SafetyTarget>(SAFETY_PANEL.targets.map((t) => [t.chembl_id, t]));
const SAFETY_BY_GENE = new Map<string, SafetyTarget>(SAFETY_PANEL.targets.map((t) => [t.gene_symbol.toUpperCase(), t]));

function lookupSafetyPanel(opts: { chemblId?: string | null; geneSymbol?: string | null }): SafetyTarget | null {
    if (opts.chemblId) {
        const hit = SAFETY_BY_CHEMBL.get(opts.chemblId);
        if (hit) return hit;
    }
    if (opts.geneSymbol) {
        const hit = SAFETY_BY_GENE.get(opts.geneSymbol.toUpperCase());
        if (hit) return hit;
    }
    return null;
}

// ── Safety-relevant tissues and expression thresholds ───────────────

export const SAFETY_RELEVANT_ORGANS = new Set([
    "heart",
    "liver",
    "kidney",
    "brain",
    "bone marrow",
    "lung",
    "thyroid",
    "pancreas",
    "adrenal",
    "gonad",
    "ovary",
    "testis",
    "stomach",
    "intestine",
    "spleen",
    "lymph node",
    "retina",
    "cochlea",
    // Reproductive — ovary/testis/gonad already above; add remaining reproductive tissues
    "placenta",
    "uterus",
    "endometrium",
    "fallopian tube",
    "epididymis",
    "prostate",
    "seminal vesicle",
    // Bone — bone marrow already above; add cortical/trabecular bone and named bones
    "bone",
    "tibia",
    "femur",
    "vertebra",
]);

export function isSafetyRelevant(tissue: string, organ?: string | null): boolean {
    const t = tissue.toLowerCase();
    const o = (organ ?? "").toLowerCase();
    for (const safe of SAFETY_RELEVANT_ORGANS) {
        if (t.includes(safe) || o.includes(safe)) return true;
    }
    return false;
}

// Reproductive/germ-cell and bone tissues often express targets at 20-80 nTPM
// in non-pathological states — applying the default 100 nTPM floor silences
// genuine tox signals. Use a lower floor for these tissues.
export const REPRODUCTIVE_TOX_TISSUES = new Set<string>([
    // Reproductive and germ-cell
    "placenta",
    "uterus",
    "endometrium",
    "fallopian tube",
    "epididymis",
    "prostate",
    "seminal vesicle",
    "ovary",
    "testis",
    // Bone — canonical target sites (e.g. CALCR in tibia) express 50-100 nTPM
    "bone",
    "tibia",
    "femur",
    "vertebra",
]);
export const REPRODUCTIVE_TOX_TPM_FLOOR = 20;
export const DEFAULT_TPM_FLOOR = 100;

// Compound HPA tissue labels that share a leading token with a
// REPRODUCTIVE_TOX_TISSUES entry but refer to anatomically distinct
// structures that should keep the default 100 nTPM floor.
// "bone marrow" shares the token "bone" with the bone entry but is
// haematopoietic tissue, not skeletal — it must not inherit the lower floor.
const REPRODUCTIVE_TOX_EXCLUDED_LABELS = new Set<string>(["bone marrow"]);

// CNS subregions carry biologically meaningful peptide-GPCR expression at
// single-digit nTPM; the default 100 floor produces audit failures for CNS
// bullets the recommendation asserts. Hypothalamus is absent — it consistently
// clears the default floor for CALCR (217 nTPM) and needs no special case.
const CNS_REGION_TISSUES = new Set<string>([
    "amygdala",
    "caudate nucleus",
    "cerebellum",
    "cerebral cortex",
    "corpus callosum",
    "frontal cortex",
    "hippocampus",
    "hippocampus proper",
    "nucleus accumbens",
    "prefrontal cortex",
    "putamen",
    "substantia nigra",
    "temporal lobe",
    "thalamus",
    "basal ganglia",
    "white matter",
    "spinal cord",
    "c1 segment of cervical spinal cord",
    "brodmann (1909) area 24",
]);

// Skeletal muscle and smooth muscle surfaces routinely show 20-80 nTPM for
// GPCRs whose ligands affect mineral and muscle metabolism.
const MUSCULOSKELETAL_TISSUES = new Set<string>([
    "skeletal muscle",
    "skeletal muscle tissue",
    "smooth muscle",
    "smooth muscle tissue",
    "cartilage",
    "synovial membrane",
]);

export function meetsTpmFloor(tissue: string, value: number): boolean {
    const t = tissue.toLowerCase();
    // REPRODUCTIVE_TOX_EXCLUDED_LABELS must be checked first — "bone marrow"
    // shares a prefix with "bone" but is haematopoietic and keeps the default floor.
    if (REPRODUCTIVE_TOX_EXCLUDED_LABELS.has(t)) return value > DEFAULT_TPM_FLOOR;
    if (CNS_REGION_TISSUES.has(t)) return value > CNS_REGION_TPM_FLOOR;
    if (MUSCULOSKELETAL_TISSUES.has(t)) return value > MUSCULOSKELETAL_TPM_FLOOR;
    for (const repro of REPRODUCTIVE_TOX_TISSUES) {
        if (t === repro || t.startsWith(repro + " ") || t.startsWith(repro + "-")) {
            return value > REPRODUCTIVE_TOX_TPM_FLOOR;
        }
    }
    return value > DEFAULT_TPM_FLOOR;
}

const CANONICAL_ORGANS: CanonicalOrgan[] = [
    "cardiac",
    "hepatic",
    "cns",
    "renal",
    "gi",
    "pancreas",
    "endocrine_thyroid",
    "metabolic",
    "hematologic",
    "immune",
    "respiratory",
    "reproductive",
    "dermatologic",
    "musculoskeletal",
];

// ── Liability summary ───────────────────────────────────────────────

export function assembleLiabilitySummary(
    phase2: Phase2Bundle,
    context: {
        offTargetRows: OffTargetPanelRows | null;
        preferredModality: string | null;
    },
) {
    const ot = phase2.phase1.collectors.opentargets;
    const drugsInClass = phase2.decisions.drugsInClass;
    const indications = ot.coverage === "available" ? ot.data.associations.map((a) => a.diseaseName) : [];
    const ta = inferTherapeuticArea(indications);

    const safetySources = [
        phase2.phase1.collectors.faersByTarget.coverage === "available" ? 1 : 0,
        phase2.phase1.collectors.ctgov.coverage === "available" ? 1 : 0,
        (context.offTargetRows ?? []).length > 0 ? 1 : 0,
        drugsInClass.coverage === "available" ? 1 : 0,
    ].reduce((a, b) => a + b, 0);

    const sameClass = drugsInClass.coverage === "available" ? drugsInClass.data.total : 0;

    const noLiabilitiesDisclosure =
        safetySources === 0 ? "insufficient safety data to assess (0 of 4 sources returned data)" : `${safetySources} of 4 safety data sources returned data`;

    return {
        liability_bullets: [],
        modality_recommendation: context.preferredModality,
        same_class_drug_count: sameClass,
        inferred_therapeutic_area: ta,
        no_liabilities_disclosure: noLiabilitiesDisclosure,
    };
}

type FanoutResults = Phase3Bundle["fanout"];

export function aggregateFaersAcrossModulators(fanout: FanoutResults | undefined) {
    if (!fanout) return null;
    const items = fanout.perModulatorFaers.results;
    const available = items.filter((i): i is Extract<typeof i, { coverage: "available" }> => i.coverage === "available");
    if (available.length === 0) return null;
    let totalReports = 0;
    let fatal = 0;
    let hospitalization = 0;
    let lifeT = 0;
    let disabling = 0;
    let congenital = 0;
    let otherSerious = 0;
    const reactionMap = new Map<string, number>();
    const reactionOrgan = new Map<string, CanonicalOrgan | null>();
    const perModulator: Array<{
        modulator: string;
        modulator_id: string | null;
        report_count: number;
        coverage: "available" | "queried_no_data" | "not_loaded";
    }> = [];
    for (const item of items) {
        if (item.coverage === "available") {
            const d = item.data;
            totalReports += d.totalReports ?? 0;
            if (d.seriousness) {
                fatal += d.seriousness.fatalCount;
                hospitalization += d.seriousness.hospitalizationCount;
                lifeT += d.seriousness.lifeThreateningCount;
                disabling += d.seriousness.disablingCount;
                congenital += d.seriousness.congenitalAnomalyCount ?? 0;
                otherSerious += d.seriousness.otherSeriousCount ?? 0;
            }
            for (const r of d.topReactions) {
                reactionMap.set(r.reaction, (reactionMap.get(r.reaction) ?? 0) + r.count);
                if (!reactionOrgan.has(r.reaction)) {
                    reactionOrgan.set(r.reaction, classifyOrgan(r.reaction));
                }
            }
            perModulator.push({
                modulator: d.preferredName,
                modulator_id: d.moleculeChemblId,
                report_count: d.totalReports ?? 0,
                coverage: "available",
            });
        } else {
            perModulator.push({
                modulator: "unknown",
                modulator_id: null,
                report_count: 0,
                coverage: item.coverage,
            });
        }
    }
    const top_signals = [...reactionMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 25)
        .map(([term, count]) => ({
            meddra_term: term,
            organ: reactionOrgan.get(term) ?? undefined,
            report_count: count,
        }));
    const totalSeriousnessSum = fatal + hospitalization + lifeT + disabling + congenital + otherSerious;
    const haveAnySeriousness = totalSeriousnessSum > 0;
    const seriousness = haveAnySeriousness
        ? {
              coverage: "available" as const,
              total_reports: totalReports,
              by_seriousness: {
                  death: fatal,
                  life_threatening: lifeT,
                  hospitalization,
                  disabling,
                  other_serious: otherSerious,
                  congenital_anomaly: congenital,
              },
              fatal_report_count: fatal,
          }
        : {
              coverage: "queried_no_data" as const,
              total_reports: totalReports,
          };

    return {
        total_reports: totalReports,
        seriousness,
        top_signals,
        per_modulator: perModulator,
    };
}

export function aggregateTrialAes(fanout: FanoutResults | undefined) {
    if (!fanout) return null;
    const items = fanout.perTrialAes.results;
    const available = items.filter((i): i is Extract<typeof i, { coverage: "available" }> => i.coverage === "available");
    if (available.length === 0) return null;

    type AggKey = string;
    const serious = new Map<AggKey, { affected: number; atRisk: number; ncts: Set<string>; organ?: string }>();
    const non = new Map<AggKey, { affected: number; atRisk: number; ncts: Set<string>; organ?: string }>();

    // Pick the worst-rate arm per (term, trial); aggregate per arm to avoid mixing denominators.
    for (const item of available) {
        for (const ev of item.data.events) {
            let bestAffected = 0;
            let bestAtRisk = 0;
            let bestRate = -1;
            for (const c of ev.counts) {
                const affected = c.numAffected ?? 0;
                const atRisk = c.numAtRisk ?? 0;
                if (atRisk <= 0) continue;
                const rate = affected / atRisk;
                if (rate > bestRate) {
                    bestRate = rate;
                    bestAffected = affected;
                    bestAtRisk = atRisk;
                }
            }
            if (bestAtRisk === 0) {
                for (const c of ev.counts) {
                    const affected = c.numAffected ?? 0;
                    if (affected > bestAffected) bestAffected = affected;
                }
            }
            const target = ev.serious ? serious : non;
            const cur = target.get(ev.term) ?? {
                affected: 0,
                atRisk: 0,
                ncts: new Set<string>(),
                organ: ev.organSystem ?? undefined,
            };
            cur.affected += bestAffected;
            cur.atRisk += bestAtRisk;
            cur.ncts.add(item.data.nctId);
            target.set(ev.term, cur);
        }
    }

    function shape(
        map: typeof serious,
        floorPct: number,
    ): { rows: Array<{ term: string; incidence_pct: number; organ?: string; nct_ids: string[] }>; dropped: number } {
        let dropped = 0;
        const rows = [...map.entries()]
            .map(([term, v]) => ({
                term,
                incidence_pct: v.atRisk > 0 ? Math.round((v.affected / v.atRisk) * 1000) / 10 : 0,
                organ: v.organ,
                nct_ids: [...v.ncts],
            }))
            .filter((row) => {
                if (row.term === "Other") {
                    dropped += 1;
                    return false;
                }
                if (row.organ && row.term === row.organ) {
                    dropped += 1;
                    return false;
                }
                return row.incidence_pct >= floorPct;
            })
            .sort((a, b) => b.incidence_pct - a.incidence_pct)
            .slice(0, 50);
        return { rows, dropped };
    }

    const seriousShape = shape(serious, 0);
    const nonShape = shape(non, 2);
    const trials_queried = available.length;
    const trials_with_ae_data = available.filter((i) => i.data.events.length > 0).length;
    return {
        serious: seriousShape.rows,
        non_serious: nonShape.rows,
        non_serious_floor_pct: 2,
        dropped_uninformative_count: seriousShape.dropped + nonShape.dropped,
        coverage_qualifier: {
            trials_queried,
            trials_with_ae_data,
            serious_floor_applied: 0,
            non_serious_floor_pct_applied: 2,
        },
    };
}

// ── Off-target panel filter/dedup ───────────────────────────────────────────

/** Fold below this threshold → selectivity window is insufficient. */
export const SELECTIVITY_FOLD_THRESHOLD = 30;

const SENTINEL_OFF_TARGET_NAMES = new Set<string>(["unchecked", "unknown", "n/a"]);

/**
 * Common cell-line names that appear in ChEMBL polypharm hits but are not
 * biological targets. Filtered out before panel assembly.
 */
const CELL_LINE_NAME_PATTERNS =
    /\b(hek293|hek-293|cho|hela|3t3|293t|293|jurkat|raw264|raw\s*264|cos-7|cos7|mcf-7|mcf7|pc-3|pc3|lncap|a549|u2os|ht-29|ht29|sk-ov-3|skov3|t47d|mda-mb|nih3t3)\b/i;

export type RawOffTargetRow = {
    off_target_id?: string | null;
    off_target_name?: string | null;
    target_chembl_id?: string | null;
    target_type?: string | null;
    accession?: string | null;
    pchembl: number;
    selectivity: { fold: number; log_units: number };
    selectivity_window_below_threshold?: boolean;
    evidence?: EvidenceItem[];
    organ_system?: string | null;
    target_class?: string | undefined;
    is_safety_panel_target?: boolean;
    clinical_consequence?: string | null;
    metadata?: { merged_chembl_ids?: string[] };
};

export type CleanOffTargetRow = Omit<RawOffTargetRow, "target_chembl_id" | "target_type" | "accession" | "off_target_id" | "organ_system" | "evidence"> & {
    off_target_id: string | null;
    off_target_name: string;
    organ_system: string | null;
    evidence: EvidenceItem[];
    selectivity_window_below_threshold: boolean;
    clinical_consequence: string | null;
    is_safety_panel_target: boolean;
    metadata: { merged_chembl_ids: string[] };
};

/**
 * V4 off-target row shape after relationship classification. Used by the
 * organ-rollup builder, evidence tally, and liability-summary signal count —
 * the typed members all rely on `relationship`, `organ_system`, `pchembl`,
 * `evidence`, and `is_safety_panel_target` only.
 */
export type OffTargetPanelRows = Array<{
    off_target_id: string | null;
    off_target_name: string;
    pchembl: number;
    is_safety_panel_target: boolean;
    organ_system: string | null;
    evidence: EvidenceItem[];
    relationship: "off_target";
}>;

/**
 * Filter and deduplicate raw off-target rows before panel assembly.
 *
 * Removes: on-target self-rows, cell-line entries, sentinel/unresolved names.
 * Deduplicates: by UniProt accession when present, otherwise by normalized name;
 *   keeps the highest-pchembl row as the winner and records merged ChEMBL ids.
 * Computes: `selectivity_window_below_threshold`, `clinical_consequence`,
 *   `is_safety_panel_target` (via the existing safety-panel lookup).
 */
export function filterAndDedupOffTargetRows(rows: RawOffTargetRow[], ctx: { assessmentTargetChemblId: string | null }): CleanOffTargetRow[] {
    const filtered = rows.filter((r) => {
        // Self-row: the primary target appearing in its own off-target panel.
        const selfId = r.off_target_id ?? r.target_chembl_id;
        if (ctx.assessmentTargetChemblId && selfId === ctx.assessmentTargetChemblId) return false;

        // Cell-line entries by target_type flag or by name pattern.
        if ((r.target_type ?? "").toUpperCase() === "CELL-LINE") return false;
        const name = (r.off_target_name ?? "").trim();
        if (CELL_LINE_NAME_PATTERNS.test(name)) return false;

        // Sentinel / unresolved names.
        const nameLower = name.toLowerCase();
        if (!nameLower || SENTINEL_OFF_TARGET_NAMES.has(nameLower)) return false;

        return true;
    });

    // Group by accession when present; otherwise by normalized name.
    const groups = new Map<string, RawOffTargetRow[]>();
    for (const r of filtered) {
        const key = r.accession ? `accession:${r.accession}` : `name:${(r.off_target_name ?? "").trim().toLowerCase()}`;
        const arr = groups.get(key) ?? [];
        arr.push(r);
        groups.set(key, arr);
    }

    const out: CleanOffTargetRow[] = [];
    for (const group of groups.values()) {
        const sorted = [...group].sort((a, b) => b.pchembl - a.pchembl);
        const winner = sorted[0]!;
        const merged_chembl_ids = sorted
            .slice(1)
            .filter((r) => r.off_target_id)
            .map((r) => r.off_target_id!);

        // `clinical_consequence` comes from the safety-panel lookup when the
        // off-target is on that panel; otherwise it is left null here and the
        // post-pass LLM annotator (annotateOffTargetPanel) fills it in.
        const { target_chembl_id: _tcid, target_type: _tt, accession: _acc, ...rest } = winner;
        out.push({
            ...rest,
            off_target_id: winner.off_target_id ?? null,
            off_target_name: (winner.off_target_name ?? winner.off_target_id ?? "").trim(),
            organ_system: winner.organ_system ?? null,
            evidence: winner.evidence ?? [],
            selectivity_window_below_threshold: winner.selectivity.fold < SELECTIVITY_FOLD_THRESHOLD,
            clinical_consequence: winner.clinical_consequence ?? null,
            is_safety_panel_target: winner.is_safety_panel_target ?? false,
            metadata: { ...(winner.metadata ?? {}), merged_chembl_ids },
        });
    }

    return out;
}

// ── Off-target panel assembly ───────────────────────────────────────

/**
 * V4 off-target panel row split. Each clean off-target row is classified as:
 *   - `on_target_self_hit`: alternate ChEMBL ID for the assessment target itself
 *   - `intended_co_target`: every modulator that hits this target intends it
 *     (e.g., GLP1R + GIPR for tirzepatide); not an off-target liability
 *   - `off_target`: real off-target — selectivity computed vs primary potency
 */
export function aggregateOffTargetPanel(
    phase2: Phase2Bundle,
    fanout: FanoutResults | undefined,
    assessmentUniprot: string,
    assessmentGeneSymbol: string = "",
    familyComplexes: FamilyComplexesBundle | null = null,
    onTargetChemblIds: string[] = [],
) {
    const accessoryProteinNames = familyComplexes?.accessoryProteinNames ?? [];
    const isHeterodimer = makeHeterodimerOfAssessmentFilter({
        assessmentGeneSymbol,
        accessoryProteinNames,
    });
    const polypharm = fanout?.perModulatorPolypharm.results ?? [];
    if (polypharm.length === 0) return null;
    const haveAny = polypharm.some((p) => p.coverage === "available");
    if (!haveAny) return null;

    const primaryChemblId =
        phase2.phase1.collectors.chemblModulators.coverage === "available" ? phase2.phase1.collectors.chemblModulators.data.targetChemblId : null;

    // Build a lookup of primaryPchembl per modulator from the fanout results so
    // computeSelectivity can produce real fold values for off-target rows.
    const primaryPchemblByModulator = new Map<string, number | null>();
    for (const item of polypharm) {
        if (item.coverage !== "available") continue;
        primaryPchemblByModulator.set(item.data.moleculeChemblId, item.data.primaryPchembl);
    }

    type Agg = {
        chemblId: string;
        name: string | null;
        pchembl: number;
        // primaryPchembl of the modulator that contributes the best off-target hit.
        modulatorPrimaryPchembl: number | null;
        modulators: Set<string>;
    };
    const byTarget = new Map<string, Agg>();
    for (const item of polypharm) {
        if (item.coverage !== "available") continue;
        for (const hit of item.data.hits) {
            if (primaryChemblId && hit.targetChemblId === primaryChemblId) continue;
            const pch = hit.pchemblValue ?? 0;
            const cur = byTarget.get(hit.targetChemblId);
            if (!cur || pch > cur.pchembl) {
                byTarget.set(hit.targetChemblId, {
                    chemblId: hit.targetChemblId,
                    name: hit.targetName ?? hit.targetChemblId,
                    pchembl: pch,
                    modulatorPrimaryPchembl: primaryPchemblByModulator.get(item.data.moleculeChemblId) ?? null,
                    modulators: cur?.modulators ?? new Set(),
                });
            }
            byTarget.get(hit.targetChemblId)!.modulators.add(item.data.moleculeChemblId);
        }
    }

    // Map off-target ChEMBL ID → primaryPchembl of the winner modulator so the
    // relationship loop can pass it to computeSelectivity without threading it
    // through the filter/dedup pipeline.
    const primaryPchemblByOffTarget = new Map<string, number | null>([...byTarget.values()].map((v) => [v.chemblId, v.modulatorPrimaryPchembl]));

    const rawRows = [...byTarget.values()]
        .map((v) => {
            const safetyHit = lookupSafetyPanel({
                chemblId: v.chemblId,
                geneSymbol: v.name,
            });
            const onPanel = safetyHit !== null;
            if (!onPanel && v.pchembl < 5) return null;
            if (onPanel && v.pchembl < 4) return null;
            return {
                off_target_id: v.chemblId,
                off_target_name: v.name ?? v.chemblId,
                target_class: undefined as string | undefined,
                pchembl: v.pchembl,
                is_safety_panel_target: onPanel,
                organ_system: safetyHit?.organ_system ?? null,
                // Safety-panel clinical_consequence is a fallback; the curated lookup
                // in filterAndDedupOffTargetRows takes precedence when available.
                clinical_consequence: safetyHit?.clinical_consequence ?? null,
                selectivity: { log_units: 0, fold: 1 },
                selectivity_window_below_threshold: false,
                modulators: [...v.modulators],
                evidence: [...v.modulators].map<EvidenceItem>((m) => ({
                    source: "chembl:polypharm",
                    predicate: "binds",
                    score: v.pchembl,
                    metadata: { off_target_id: v.chemblId, modulator: m },
                })),
            } satisfies RawOffTargetRow & { modulators: string[] };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

    // Preserve modulator membership across dedup so the v4 relationship
    // classifier (intended co-target / on-target self-hit) can see which
    // molecules actually hit each off-target.
    const modulatorsByKey = new Map<string, Set<string>>();
    for (const r of rawRows) {
        const key = `${r.off_target_id ?? ""}::${(r.off_target_name ?? "").trim().toLowerCase()}`;
        const set = modulatorsByKey.get(key) ?? new Set<string>();
        for (const m of r.modulators) set.add(m);
        modulatorsByKey.set(key, set);
    }

    const cleanRows = filterAndDedupOffTargetRows(rawRows, {
        assessmentTargetChemblId: primaryChemblId,
    });

    cleanRows.sort((a, b) => {
        if (a.is_safety_panel_target !== b.is_safety_panel_target) {
            return a.is_safety_panel_target ? -1 : 1;
        }
        return b.pchembl - a.pchembl;
    });

    // Helper: project a clean row onto the V4 base shape (no relationship yet).
    const toBaseRow = (r: CleanOffTargetRow) => ({
        off_target_id: r.off_target_id,
        off_target_name: r.off_target_name,
        target_class: r.target_class,
        pchembl: r.pchembl,
        is_safety_panel_target: r.is_safety_panel_target,
        organ_system: r.organ_system,
        clinical_consequence: r.clinical_consequence,
        evidence: r.evidence,
        metadata: r.metadata,
    });

    const rows: OffTargetRowV4[] = [];
    const excludedRows: ExcludedOffTargetRowV4[] = [];

    for (const r of cleanRows.slice(0, 50)) {
        const base = toBaseRow(r);
        const key = `${r.off_target_id ?? ""}::${r.off_target_name.trim().toLowerCase()}`;
        const modulators = [...(modulatorsByKey.get(key) ?? new Set<string>())];

        // 0. Obligate cofactor — same protein heterodimerized with a different
        //    accessory (e.g., CALCR/RAMP3 = AMY3 for a CALCR assessment).
        //    Selectivity is not pharmacologically attainable across partners.
        if (assessmentGeneSymbol && isHeterodimer(r.off_target_name)) {
            excludedRows.push({
                ...base,
                relationship: "obligate_cofactor",
                reason: `${r.off_target_name} is ${assessmentGeneSymbol} heterodimerised with a different obligate cofactor; selectivity is not pharmacologically attainable.`,
                selectivity: { selectivity_unknown: true, reason: "obligate cofactor (same protein, different RAMP/accessory)" },
                selectivity_window_below_threshold: false,
            });
            continue;
        }

        // 1. On-target self-hit (alternate ChEMBL ID for the same protein).
        if (r.off_target_id && assessmentUniprot && isOnTargetChemblId(r.off_target_id, onTargetChemblIds)) {
            excludedRows.push({
                ...base,
                relationship: "on_target_self_hit",
                reason: `${r.off_target_id} is an alternate ChEMBL ID for the on-target`,
                selectivity: { selectivity_unknown: true, reason: "on-target self-hit" },
                selectivity_window_below_threshold: false,
            });
            continue;
        }

        // 2. Intended co-target — every contributing modulator marks this target
        //    as part of the marketed mechanism (dual/triple agonist case).
        const intendedHits = modulators.map((m) => ({ m, hit: isIntendedCoTarget(m, r.off_target_id ?? "") })).filter((x) => x.hit.intended);
        if (modulators.length > 0 && intendedHits.length === modulators.length) {
            excludedRows.push({
                ...base,
                relationship: "intended_co_target",
                reason: intendedHits[0]!.hit.reason!,
                selectivity: { selectivity_unknown: true, reason: "intended co-target" },
                selectivity_window_below_threshold: false,
            });
            continue;
        }

        // 3. Real off-target — compute selectivity against primary potency.
        //    primaryPchemblByOffTarget carries the median on-target pChEMBL fetched
        //    by the polypharm fanout step. When absent (null), computeSelectivity
        //    returns selectivity_unknown with a clear reason.
        const modulatorPrimaryPchembl = r.off_target_id != null ? (primaryPchemblByOffTarget.get(r.off_target_id) ?? null) : null;
        const selectivity = computeSelectivity({
            primary_pchembl: modulatorPrimaryPchembl,
            off_target_pchembl: r.pchembl,
        });
        const below = "selectivity_unknown" in selectivity ? true : selectivity.vs_primary_potency.fold < SELECTIVITY_FOLD_THRESHOLD;
        rows.push({
            ...base,
            relationship: "off_target",
            selectivity,
            selectivity_window_below_threshold: below,
        });
    }

    // Append the IUPHAR-driven obligate-cofactor supplement for receptor-
    // accessory family complexes (e.g., CALCR → AMY1/AMY2/AMY3). The ChEMBL
    // polypharm panel may surface only some of these complexes; IUPHAR is
    // exhaustive for the registered family. Dedup against existing
    // excludedRows by off_target_name to avoid duplicate entries.
    if (familyComplexes && familyComplexes.complexes.length > 0) {
        const supplementRows = buildFamilyComplexSupplement(familyComplexes);
        const norm = (name: string) => name.trim().toLowerCase();
        const existingNames = new Set(excludedRows.map((r) => norm(r.off_target_name)));
        for (const supp of supplementRows) {
            if (!existingNames.has(norm(supp.off_target_name))) {
                excludedRows.push(supp);
            }
        }
    }

    return { rows, excluded_rows: excludedRows };
}

// ── Class-precedent drug-count helpers ─────────────────────────────────────

/** Minimum distinct active substances required for class-liability designation. */
export const CLASS_MIN_DRUGS = 3;

// Signal fraction at or above which an organ is treated as a structural class
// liability rather than an idiosyncratic AE. 0.30 ≈ 1/3 of marketed class members
// — calibrated against GLP-1R (GI 6/17 = 35% must flag) and AKT1 / non-class
// targets (sparse signals must not flag). Originally 0.50; lowered after
// dossier 9ad29ba5 review surfaced false negatives on the GLP-1R class.
export const CLASS_LIABILITY_FRACTION = 0.3;

export type ClassDrug = {
    drug_id: string;
    parent_chembl_id: string | null;
    drug_name: string;
    max_phase: number;
};

/**
 * Deduplicates a list of drugs by active substance (parent_chembl_id, falling
 * back to drug_id when parent is absent), then derives the count and suppression
 * reason used consistently across drugs_in_class and per_organ rollups.
 *
 * Dedup winner per group: highest max_phase; ties broken by drug_id lexicographic
 * order so the result is deterministic.
 */
export function computeClassPrecedentCounts(drugs: ClassDrug[]): {
    drug_count_in_class: number;
    drugs_in_class: ClassDrug[];
    suppressed_reason: string | null;
} {
    const groups = new Map<string, ClassDrug[]>();
    for (const d of drugs) {
        const key = d.parent_chembl_id ?? d.drug_id;
        const arr = groups.get(key) ?? [];
        arr.push(d);
        groups.set(key, arr);
    }
    const deduped: ClassDrug[] = [];
    for (const group of groups.values()) {
        const winner = [...group].sort((a, b) => {
            if ((b.max_phase ?? 0) !== (a.max_phase ?? 0)) return (b.max_phase ?? 0) - (a.max_phase ?? 0);
            return a.drug_id.localeCompare(b.drug_id);
        })[0]!;
        deduped.push(winner);
    }
    const drug_count_in_class = deduped.length;
    const suppressed_reason = drug_count_in_class < CLASS_MIN_DRUGS ? `class size ${drug_count_in_class} below ${CLASS_MIN_DRUGS}-drug minimum` : null;
    return { drug_count_in_class, drugs_in_class: deduped, suppressed_reason };
}

export function aggregateClassPrecedent(phase2: Phase2Bundle, fanout: FanoutResults | undefined) {
    const dic = phase2.decisions.drugsInClass;
    if (dic.coverage !== "available" || dic.data.drugs.length === 0) return null;

    // Build a lookup from moleculeChemblId -> parentChemblId using the modulator
    // collector data. The LLM drugsInClass output does not carry parentChemblId,
    // but the collector does — this join is the deterministic backstop for
    // dedup-by-active-substance.
    const modCollector = phase2.phase1.collectors.chemblModulators;
    const parentMap = new Map<string, string | null>();
    if (modCollector.coverage === "available") {
        for (const m of modCollector.data.modulators) {
            parentMap.set(m.moleculeChemblId, m.parentChemblId);
        }
    }

    const rawDrugs: ClassDrug[] = dic.data.drugs.map((d) => ({
        drug_id: d.moleculeChemblId,
        parent_chembl_id: parentMap.has(d.moleculeChemblId) ? (parentMap.get(d.moleculeChemblId) ?? null) : null,
        drug_name: d.preferredName,
        max_phase: Math.round(d.maxPhase ?? 0),
    }));

    const { drug_count_in_class, drugs_in_class } = computeClassPrecedentCounts(rawDrugs);

    if (!fanout) return { drugs_in_class, per_organ: [] };
    const items = fanout.perClassDrugAes.results;

    // Map FAERS results back to their deduped representative drug_id so signals
    // from both CHEMBL3989767 and CHEMBL4594242 (same active substance) count as
    // one drug in the denominator.
    const dedupKeyForFaersDrug = (moleculeChemblId: string): string => {
        const parent = parentMap.get(moleculeChemblId);
        return parent ?? moleculeChemblId;
    };

    type OrganAgg = {
        dedupKeys: Set<string>;
        dedupKeysWithSignal: Set<string>;
        aes: Map<string, number>;
    };
    const organMap = new Map<CanonicalOrgan, OrganAgg>();
    const totalDedupKeys = new Set<string>();
    for (const item of items) {
        if (item.coverage !== "available") continue;
        const dedupKey = dedupKeyForFaersDrug(item.data.moleculeChemblId);
        totalDedupKeys.add(dedupKey);
        const totalReports = item.data.totalReports ?? 0;
        for (const r of item.data.topReactions) {
            const organ = classifyOrgan(r.reaction);
            if (!organ) continue;
            const cur =
                organMap.get(organ) ??
                ({
                    dedupKeys: new Set<string>(),
                    dedupKeysWithSignal: new Set<string>(),
                    aes: new Map<string, number>(),
                } satisfies OrganAgg);
            cur.dedupKeys.add(dedupKey);
            if (totalReports > 0) cur.dedupKeysWithSignal.add(dedupKey);
            cur.aes.set(r.reaction, (cur.aes.get(r.reaction) ?? 0) + r.count);
            organMap.set(organ, cur);
        }
    }

    // Use drug_count_in_class from the deduped drugs_in_class list as the
    // authoritative denominator. Fall back to FAERS-observed distinct drugs if
    // the deduped list is empty (shouldn't happen in practice).
    const denominator = drug_count_in_class > 0 ? drug_count_in_class : totalDedupKeys.size;

    const per_organ = [...organMap.entries()].map(([organ, v]) => {
        const drugsWithSignal = v.dedupKeysWithSignal.size;
        const fraction = denominator > 0 ? drugsWithSignal / denominator : 0;
        const isLiability = denominator >= CLASS_MIN_DRUGS && fraction >= CLASS_LIABILITY_FRACTION;
        const suppressed_reason = !isLiability && denominator < CLASS_MIN_DRUGS ? `class size ${denominator} below ${CLASS_MIN_DRUGS}-drug minimum` : null;
        return {
            organ,
            drug_count_in_class: denominator,
            drugs_with_signal: drugsWithSignal,
            signal_fraction: fraction,
            is_class_liability: isLiability,
            suppressed_reason,
            top_aes: [...v.aes.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([term, count]) => ({ term, report_count: count })),
        };
    });
    return { drugs_in_class, per_organ };
}

// ── Organ rollup ────────────────────────────────────────────────────

/**
 * Build the minimal synthetic body shape that expectedOrgansFromBody needs
 * from the assembler's intermediate aggregates (before the full body is
 * assembled). This ensures the assembler's organ_rollup gap-fill uses the
 * same `classifyTrialAe` + `classifyOrgan` logic as the derived validator —
 * preventing derived-invariant-violation at persist time.
 */
function syntheticBodyForExpectedOrgans(
    faers: ReturnType<typeof aggregateFaersAcrossModulators>,
    trialAes: ReturnType<typeof aggregateTrialAes>,
    offTarget: OffTargetPanelRows | null,
) {
    return {
        safety_profile: {
            faers: { data: { top_signals: faers?.top_signals ?? [] } },
            trial_aes: { data: { serious: trialAes?.serious ?? [] } },
            off_target_panel: { data: { rows: offTarget ?? [] } },
        },
    };
}

const MALIGNANCY_RE = /malignan|cancer|carcinoma|neoplasm/i;

export function buildOrganRollup(
    faers: ReturnType<typeof aggregateFaersAcrossModulators>,
    trialAes: ReturnType<typeof aggregateTrialAes>,
    offTarget: OffTargetPanelRows | null,
    classP: ReturnType<typeof aggregateClassPrecedent>,
    regulatoryActions?: RegulatoryActionRow[] | null,
) {
    if (!faers && !trialAes && !offTarget && !classP && !regulatoryActions?.length) return null;
    const rows = CANONICAL_ORGANS.map((organ) => {
        // off_target_panel.organ_system is the curated safety-panel canonical
        // string (`cardiac` | `hepatic` | `cns` | `renal` | `gi` |
        // `hematologic` | `immune` | `metabolic` | `respiratory`). Use direct
        // string equality first; `classifyOrgan` falls back if a future
        // collector emits a non-canonical string.
        const polypharmHits = (offTarget ?? []).filter((r) => classifyPolypharmOrgan(r.organ_system) === organ);
        const polypharmCount = polypharmHits.length;

        const faersHits = (faers?.top_signals ?? []).filter((s) => s.organ === organ);
        const faersCount = faersHits.length;

        // trial_aes.serious rows carry the CT.gov SOC string in `.organ`
        // (e.g. "Gastrointestinal disorders") and the MedDRA PT in `.term`
        // (e.g. "nausea"). `classifyTrialAe` maps the SOC first, then falls
        // back to PT classification — the same logic the derived-completeness
        // validator uses, so the assembler and validator agree on the
        // expected organ set.
        const trialHits = (trialAes?.serious ?? []).filter((e) => classifyTrialAe(e) === organ);
        const trialCount = trialHits.length;

        const classOrgan = (classP?.per_organ ?? []).find((o) => o.organ === organ);
        const classLiability = !!classOrgan?.is_class_liability;

        // Trial AEs are weighted as half a signal for risk classification
        // because they lack drug attribution and comparator-arm handling.
        // FAERS, off-target, and class-liability are full signals.
        const signalScore = (polypharmCount > 0 ? 1 : 0) + (faersCount > 0 ? 1 : 0) + (trialCount > 0 ? 0.5 : 0) + (classLiability ? 1 : 0);
        const signalTypeCount = (polypharmCount > 0 ? 1 : 0) + (faersCount > 0 ? 1 : 0) + (trialCount > 0 ? 1 : 0) + (classLiability ? 1 : 0);
        const risk: "high" | "medium" | "low" = signalScore >= 2.5 ? "high" : signalScore >= 1.5 ? "medium" : "low";

        const evidence: EvidenceItem[] = [
            ...polypharmHits.map<EvidenceItem>((h) => ({
                source: "chembl:polypharm",
                predicate: "off_target_binding",
                score: h.pchembl,
                metadata: { off_target_id: h.off_target_id, organ_system: h.organ_system },
            })),
            ...faersHits.map<EvidenceItem>((s) => ({
                source: "openfda:faers",
                predicate: "post_market_signal",
                metadata: { meddra_term: s.meddra_term, count: s.report_count },
            })),
            ...trialHits.map<EvidenceItem>((t) => ({
                source: "ctgov:trial_aes",
                predicate: "trial_adverse_event",
                is_clinical: true,
                metadata: {
                    term: t.term,
                    incidence_pct: t.incidence_pct,
                    nct_ids: t.nct_ids,
                },
            })),
            ...(classOrgan
                ? [
                      {
                          source: "class_precedent",
                          predicate: "class_liability",
                          metadata: {
                              drug_count_in_class: classOrgan.drug_count_in_class,
                              drugs_with_signal: classOrgan.drugs_with_signal,
                              signal_fraction: classOrgan.signal_fraction,
                          },
                      } satisfies EvidenceItem,
                  ]
                : []),
        ];

        return {
            organ,
            risk_level: risk,
            signal_type_count: signalTypeCount,
            signals: {
                chembl_polypharm_count: polypharmCount,
                faers_count: faersCount,
                trial_ae_count: trialCount,
                class_liability_present: classLiability,
            },
            evidence,
        };
    });

    // Drop rows with no signals, then guarantee every expected organ has a row.
    const filtered = rows.filter((r) => r.signal_type_count > 0);
    const presentOrgans = new Set(filtered.map((r) => r.organ));
    const expected = expectedOrgansFromBody(syntheticBodyForExpectedOrgans(faers, trialAes, offTarget)) as CanonicalOrgan[];
    for (const organ of expected) {
        if (presentOrgans.has(organ)) continue;
        const matchingFaers = (faers?.top_signals ?? []).filter((s) => classifyOrgan(s.meddra_term) === organ);
        const matchingAes = (trialAes?.serious ?? []).filter((a) => classifyTrialAe(a) === organ);
        filtered.push({
            organ,
            risk_level: matchingAes.length > 0 ? "high" : "medium",
            signal_type_count: (matchingFaers.length > 0 ? 1 : 0) + (matchingAes.length > 0 ? 1 : 0),
            signals: {
                chembl_polypharm_count: 0,
                faers_count: matchingFaers.length,
                trial_ae_count: matchingAes.length,
                class_liability_present: false,
            },
            evidence: [
                ...matchingFaers.slice(0, 3).map<EvidenceItem>((s) => ({
                    source: "openfda:faers",
                    predicate: "post_market_signal",
                    metadata: { count: s.report_count, meddra_term: s.meddra_term },
                })),
                ...matchingAes.slice(0, 3).map<EvidenceItem>((a) => ({
                    source: "ctgov:trial_aes",
                    predicate: "trial_adverse_event",
                    is_clinical: true,
                    metadata: {
                        term: a.term,
                        nct_ids: a.nct_ids,
                        incidence_pct: a.incidence_pct,
                    },
                })),
            ],
        });
        presentOrgans.add(organ);
    }

    // Oncology synthesis: when regulatory_actions carries malignancy-keyword
    // findings, emit an oncology rollup row. This is ADDITIVE — it does not
    // replace any row produced by the main CANONICAL_ORGANS loop above.
    if (!presentOrgans.has("oncology") && regulatoryActions?.length) {
        const malignancyRows = regulatoryActions.filter((r) => MALIGNANCY_RE.test(r.finding));
        if (malignancyRows.length > 0) {
            filtered.push({
                organ: "oncology",
                risk_level: "high",
                signal_type_count: 1,
                signals: {
                    chembl_polypharm_count: 0,
                    faers_count: 0,
                    trial_ae_count: 0,
                    class_liability_present: true,
                },
                evidence: malignancyRows.map<EvidenceItem>((r) => ({
                    source: "regulatory_actions",
                    predicate: "malignancy_signal",
                    metadata: {
                        agency: r.agency,
                        action_kind: r.action_kind,
                        action_date: r.action_date,
                        drug_name: r.drug_name,
                    },
                })),
            });
        }
    }

    return filtered;
}

/**
 * Testable wrapper around `buildOrganRollup` that accepts named parameters.
 * Exported for unit tests; production code calls `buildOrganRollup` directly
 * inside `assembleDossier`.
 */
export function assembleOrganRollupRows(opts: {
    classPrecedent?: ReturnType<typeof aggregateClassPrecedent> | null;
    regulatoryActions?: { coverage: string; data?: { rows: RegulatoryActionRow[] } } | null;
}): ReturnType<typeof buildOrganRollup> extends null ? never[] : NonNullable<ReturnType<typeof buildOrganRollup>> {
    const regRows = opts.regulatoryActions?.coverage === "available" ? (opts.regulatoryActions.data?.rows ?? null) : null;
    return buildOrganRollup(null, null, null, opts.classPrecedent ?? null, regRows) ?? [];
}

// ── §2.4 Drug Interactions ──────────────────────────────────────────

export function assembleDrugInteractions(phase2: Phase2Bundle, enrichedModulators?: ChemblModulator[]) {
    const mods = phase2.phase1.collectors.chemblModulators;
    if (mods.coverage !== "available" || mods.data.modulators.length === 0) {
        return null;
    }
    const modulatorList = enrichedModulators ?? mods.data.modulators;
    if (modulatorList.length === 0) {
        return null;
    }
    const triage = phase2.decisions.modulatorTriage;
    const triageRationales = new Map<string, string>();
    if (triage.coverage === "available") {
        for (const t of triage.data.shortlist) {
            triageRationales.set(t.moleculeChemblId, t.rationale);
        }
    }
    const rows = modulatorList.slice(0, 50).map((m) => {
        const phase = Math.round(m.maxPhase ?? 0);
        const score = phase >= 4 ? 1 : phase >= 1 ? phase / 4 : 0;
        const hasClinical = phase >= 1;
        return {
            drug_id: m.moleculeChemblId,
            drug_name: m.preferredName ?? m.moleculeChemblId,
            best_score: score,
            predicates: ["modulates"],
            sources: ["chembl"],
            paper_count: 0,
            dominant_direction: "unknown" as const,
            has_human_evidence: hasClinical,
            has_clinical_evidence: hasClinical,
            evidence: [
                {
                    source: "chembl:modulator",
                    predicate: "modulates",
                    score,
                    is_clinical: hasClinical,
                    is_human: hasClinical,
                    metadata: {
                        chembl_id: m.moleculeChemblId,
                        max_phase: phase,
                        molecule_type: m.moleculeType,
                        first_approval: m.firstApproval,
                        triage_rationale: triageRationales.get(m.moleculeChemblId),
                    },
                } satisfies EvidenceItem,
            ],
        };
    });
    return rows.sort((a, b) => b.best_score - a.best_score);
}
