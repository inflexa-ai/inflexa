/**
 * Phase-4 deterministic assemblers.
 *
 * Each assembler maps Phase-1 / Phase-2 / Phase-3 outputs onto the
 * corresponding dossier section schema. Coverage is honored end-to-end:
 * when an upstream came back `queried_no_data` or the derived row set is
 * empty, the section is marked `queried_no_data` / `not_loaded` rather
 * than fabricated. Aggregate rows preserve their contributing evidence
 * under `evidence: [...]` arrays.
 */

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

import {
    aggregateFaersAcrossModulators,
    aggregateTrialAes,
    aggregateOffTargetPanel,
    aggregateClassPrecedent,
    buildOrganRollup,
    assembleDrugInteractions,
    assembleLiabilitySummary,
    meetsTpmFloor,
    isSafetyRelevant,
} from "./safety.js";
import {
    assemblePreclinicalLiterature,
    assembleKoSupportingLiterature,
    tallyInternalReferences,
    assembleKeyPapers,
    assembleEvidenceTimeline,
    assembleTranslationalChain,
    assembleMolecularInteractions,
    assembleBiomarkerPotential,
    assembleResistanceEvidence,
    assembleCombinationEvidence,
    assembleEvidenceConflicts,
    assembleAdditionalEvidence,
    isSelfReference,
    isClinicalMeasurement,
    indicationCompositeScore,
    partitionTrialsByAttribution,
    classifyClinicalTrialConfidence,
    assembleDiscoveryTrials,
    dedupePpiPartners,
} from "./literature.js";
import { buildTrialOutcomeFilter, aggregateTrialOutcomes } from "./trials.js";
import { buildFailureCategoryDiscriminated } from "./literature.js";
import type { AttributionContext } from "./literature.js";

const NOT_LOADED_PHASE5 = "Phase 5 synthesis not yet implemented";

// Order matches evidence-priority rank: genetic > known_drug > animal_model > somatic > literature.
function makeAssociationEvidence(a: {
    diseaseId: string;
    geneticAssociationScore: number | null;
    knownDrugScore: number | null;
    literatureScore: number | null;
    animalModelScore: number | null;
    somaticMutationScore: number | null;
}): EvidenceItem[] {
    const out: EvidenceItem[] = [];
    if (a.geneticAssociationScore != null) {
        out.push({
            source: "opentargets:genetic_association",
            score: a.geneticAssociationScore,
            predicate: "associated_with",
            is_human: true,
            metadata: { disease_id: a.diseaseId },
        });
    }
    if (a.knownDrugScore != null) {
        out.push({
            source: "opentargets:known_drug",
            score: a.knownDrugScore,
            predicate: "therapeutic_target",
            is_human: true,
            is_clinical: true,
            metadata: { disease_id: a.diseaseId },
        });
    }
    if (a.animalModelScore != null) {
        out.push({
            source: "opentargets:animal_model",
            score: a.animalModelScore,
            predicate: "validated_in_animal_model",
            metadata: { disease_id: a.diseaseId },
        });
    }
    if (a.somaticMutationScore != null) {
        out.push({
            source: "opentargets:somatic_mutation",
            score: a.somaticMutationScore,
            predicate: "somatic_mutation_associated",
            is_human: true,
            metadata: { disease_id: a.diseaseId },
        });
    }
    if (a.literatureScore != null) {
        out.push({
            source: "opentargets:literature",
            score: a.literatureScore,
            predicate: "literature_co_occurrence",
            metadata: { disease_id: a.diseaseId },
        });
    }
    return out;
}

// ── Section assemblers ───────────────────────────────────────────────

export function assembleEntity(resolved: ResolvedTarget): Entity {
    return {
        canonicalId: resolved.canonicalId,
        symbol: resolved.geneSymbol,
        displayName: resolved.approvedName,
        entityType: "gene",
        ontology: resolved.canonicalOntology === "hgnc" ? "HGNC" : "Ensembl",
        identifiers: {
            hgnc: resolved.ids.hgnc ?? undefined,
            ensembl: resolved.ids.ensembl ?? undefined,
            uniprot: resolved.ids.uniprot ?? undefined,
            chembl: resolved.ids.chembl ?? undefined,
            ncbiGene: resolved.ids.entrez ?? undefined,
        },
        synonyms: resolved.synonyms,
        proteinFamily: resolved.proteinFamily ?? undefined,
    };
}

type OpenTargetsCoverageResult = Phase2Bundle["phase1"]["collectors"]["opentargets"];

// Maps ChEMBL molecule_type (lowercase) to the tractability modality bucket.
const MOLECULE_TYPE_TO_MODALITY: Record<string, "small_molecule" | "antibody" | "other_clinical"> = {
    "small molecule": "small_molecule",
    antibody: "antibody",
    "antibody-drug conjugate": "antibody",
    protein: "other_clinical",
    peptide: "other_clinical",
    enzyme: "other_clinical",
};

function normalizeDrugMoleculeType(drug: Pick<DrugForTractability, "drug_name" | "molecule_type">): string | null {
    const name = (drug.drug_name ?? "").trim().toUpperCase();
    // SMC021 is oral salmon calcitonin, not a non-peptide small molecule. Some
    // source paths can describe the formulation as oral and accidentally leave a
    // small-molecule annotation downstream; keep the therapeutic substance class.
    if (name === "SMC021" || name.includes("SALMON CALCITONIN") || name.includes("CALCITONIN SALMON")) {
        return "Peptide";
    }
    return drug.molecule_type;
}

export type DrugForTractability = {
    drug_id: string;
    drug_name: string | null;
    molecule_type: string | null;
    max_phase: number | null;
};

/**
 * Pure helper that flips `has_approved_drug=true` and populates
 * `approved_drug_ids` on any modality that has a max_phase=4 drug in
 * the provided list. Unrecognised molecule_types are silently ignored.
 */
export function enrichTractabilityModalitiesWithApprovals<
    M extends {
        modality: "small_molecule" | "antibody" | "other_clinical";
        has_approved_drug: boolean;
        approved_drug_ids?: string[];
    },
>(modalities: M[], drugs: DrugForTractability[]): (M & { approved_drug_ids?: string[] })[] {
    const approvedByModality = new Map<string, string[]>();
    for (const d of drugs) {
        if ((d.max_phase ?? 0) < 4) continue;
        const mod = MOLECULE_TYPE_TO_MODALITY[(normalizeDrugMoleculeType(d) ?? "").toLowerCase()];
        if (!mod) continue;
        const arr = approvedByModality.get(mod) ?? [];
        arr.push(d.drug_id);
        approvedByModality.set(mod, arr);
    }
    return modalities.map((m) => {
        const ids = approvedByModality.get(m.modality);
        if (!ids || ids.length === 0) return m;
        return { ...m, has_approved_drug: true, approved_drug_ids: [...new Set(ids)].sort() };
    });
}

export function assembleTractability(resolved: ResolvedTarget, ot: OpenTargetsCoverageResult, drugs: DrugForTractability[]): TractabilityV4Section {
    const familyFallback = () => {
        const fallback = inferModalityFromFamily(resolved.proteinFamily);
        return {
            coverage: "available" as const,
            data: {
                modalities: [
                    {
                        modality: "small_molecule" as const,
                        levels: [],
                        has_approved_drug: false,
                        has_clinical_stage: false,
                        is_inferred_from_family: true,
                    },
                ],
                preferred_modality: fallback.preferred_modality,
                drug_molecule_types_present: [] as string[],
            },
            inference_path: `family-fallback (${fallback.source}: ${fallback.family ?? "default"}) — ${fallback.rationale}`,
        };
    };
    if (ot.coverage !== "available") return familyFallback();
    const t = ot.data.tractability;
    if (!t) return familyFallback();
    const modalities = [
        {
            modality: "small_molecule" as const,
            levels: t.smallMolecule ? ["validated"] : [],
            has_approved_drug: false,
            has_clinical_stage: !!t.smallMolecule,
            is_inferred_from_family: false,
        },
        {
            modality: "antibody" as const,
            levels: t.antibody ? ["validated"] : [],
            has_approved_drug: false,
            has_clinical_stage: !!t.antibody,
            is_inferred_from_family: false,
        },
        {
            modality: "other_clinical" as const,
            levels: t.otherModalities ? ["validated"] : [],
            has_approved_drug: false,
            has_clinical_stage: !!t.otherModalities,
            is_inferred_from_family: false,
        },
    ];
    const preferred = t.smallMolecule ? "small_molecule" : t.antibody ? "antibody" : t.otherModalities ? "other_clinical" : null;
    const modalitiesEnriched = enrichTractabilityModalitiesWithApprovals(modalities, drugs);
    // Collect molecule types from approved/clinical drugs for the v4 field.
    const drugMoleculeTypes = [...new Set(drugs.map((d) => d.molecule_type).filter((m): m is string => !!m))];
    return {
        coverage: "available",
        data: {
            modalities: modalitiesEnriched,
            preferred_modality: preferred,
            drug_molecule_types_present: drugMoleculeTypes,
        },
    };
}

// ── Top-level dossier assembly ──────────────────────────────────────

/**
 * Build a body-only dossier from Phase-2 (and optionally Phase-3)
 * outputs. Synthesis-dependent fields stay `not_loaded` until Phase 5
 * stamps them in `phase5-persist.ts`. The derived sub-tree is NOT
 * attached here — phase5-persist computes it after synthesis is stamped
 * so the final derived values reflect liability bullets and safety flags.
 */
export async function assembleDossier(
    pool: Pool,
    phase2: Phase2Bundle,
    phase3?: Phase3Bundle,
    annotatorDeps?: ClinicalConsequenceAnnotatorDeps,
): Promise<DossierV4Body> {
    const fanout = phase3?.fanout;
    const faersAgg = aggregateFaersAcrossModulators(fanout);
    const trialAesAgg = aggregateTrialAes(fanout);

    // Off-target panel needs the assessment UniProt and gene symbol: UniProt to
    // recognise alternate ChEMBL IDs as self-hits, gene symbol to detect
    // obligate-cofactor heterodimers (e.g., CALCR/RAMP3 = AMY3 for CALCR).
    const assessmentUniprot = phase2.phase1.resolved.ids.uniprot ?? "";
    const geneSymbol = phase2.phase1.resolved.geneSymbol ?? "";

    const familyComplexesCollector = phase2.phase1.collectors.familyComplexes;
    const familyComplexesBundle = familyComplexesCollector.coverage === "available" ? familyComplexesCollector.data : null;
    const [onTargetChemblIds, familySiblingUniprots] = await Promise.all([
        resolveOnTargetChemblIds(assessmentUniprot),
        resolveFamilySiblingUniprots(assessmentUniprot || geneSymbol),
    ]);
    const offTargetPanel = aggregateOffTargetPanel(phase2, fanout, assessmentUniprot, geneSymbol, familyComplexesBundle, onTargetChemblIds);
    if (offTargetPanel) {
        await annotateOffTargetPanel(pool, offTargetPanel, geneSymbol, annotatorDeps);
    }
    const offTargetRows = offTargetPanel?.rows ?? null;
    const classP = aggregateClassPrecedent(phase2, fanout);

    // Enrich modulator metadata before any downstream assembly so that
    // tractability, drug_interactions, and class-precedent all see the same
    // PubChem-refined molecule_type for entries that ChEMBL labelled "Unknown".
    const chemblModsCollector = phase2.phase1.collectors.chemblModulators;
    const enrichedModulators = chemblModsCollector.coverage === "available" ? await resolveModulatorMoleculeType(chemblModsCollector.data.modulators) : [];

    // drugInteractionRows must be computed before buildOrganRollup so we can
    // derive the drug IDs for regulatory_actions lookup and pass them in.
    const drugInteractionRows = assembleDrugInteractions(phase2, enrichedModulators);
    const regulatoryActionRows = await fetchRegulatoryActions((drugInteractionRows ?? []).map((d) => ({ chemblId: d.drug_id, name: d.drug_name })));
    const organRollupRows = buildOrganRollup(faersAgg, trialAesAgg, offTargetRows, classP, regulatoryActionRows.length > 0 ? regulatoryActionRows : null);
    const preclinicalLitData = assemblePreclinicalLiterature(phase2);
    const koSupportingLiterature = assembleKoSupportingLiterature(phase2);
    const internalRefCounts = tallyInternalReferences([
        koSupportingLiterature,
        ...(organRollupRows ?? []).map((r) => r.evidence),
        ...(offTargetRows ?? []).map((r: any) => r.evidence),
    ]);
    const keyPapersRows = assembleKeyPapers(phase2, internalRefCounts);
    const evidenceTimeline = assembleEvidenceTimeline(phase2);
    const translationalChain = assembleTranslationalChain(phase2);
    const attrCtx: AttributionContext = {
        assessmentUniprot,
        assessmentSymbol: phase2.phase1.resolved.geneSymbol,
        familyUniprots: familySiblingUniprots,
        drugTargetResolver: getDrugPrimaryTargetUniprots,
    };

    // Derive known class drug names from ChEMBL modulators (uppercase) for
    // drug_in_class_match classification inside assembleDiscoveryTrials.
    const knownClassDrugNames = new Set<string>((drugInteractionRows ?? []).map((r) => r.drug_name.toUpperCase()));

    // Build the attribution filter for aggregateTrialOutcomes by partitioning
    // all ctgov trials (active + failed) with the same attribution logic used
    // for clinical_development.trials. This drops erenumab/paralog trials from
    // clinical_development.outcomes when their ChEMBL IDs resolve to a related
    // receptor rather than the assessment target.
    const trialOutcomeFilter = await buildTrialOutcomeFilter(phase2, attrCtx, knownClassDrugNames, phase2.phase1.resolved.geneSymbol);

    const trialOutcomesRows = aggregateTrialOutcomes(fanout, trialOutcomeFilter);

    const discoveryTrialData = await assembleDiscoveryTrials(phase2, phase2.phase1.resolved.geneSymbol, attrCtx, knownClassDrugNames);

    const resolved = phase2.phase1.resolved;
    const ot = phase2.phase1.collectors.opentargets;
    const ctgov = phase2.phase1.collectors.ctgov;
    const clinvar = phase2.phase1.collectors.clinvar;
    const cbioportal = phase2.phase1.collectors.cbioportal;
    const expression = phase2.phase1.collectors.expressionHuman;
    const expressionMulti = phase2.phase1.collectors.expressionMultiSpecies;
    const impc = phase2.phase1.collectors.impc;
    const pubmed = phase2.phase1.collectors.pubmedIndex;
    const pathways = phase2.phase1.collectors.pathways;
    const ppi = phase2.phase1.collectors.stringPpi;

    const indicationsRaw = ot.coverage === "available" ? ot.data.associations : [];
    const filteredIndications = indicationsRaw.filter(
        (a) => !isSelfReference(resolved.canonicalId, a.diseaseId, resolved.geneSymbol, a.diseaseName) && !isClinicalMeasurement(a.diseaseName),
    );
    const ta = inferTherapeuticArea(filteredIndications.map((a) => a.diseaseName));
    const benchmarks = getBenchmarks(ta);
    const datasetAttr = getDatasetAttribution();

    const offTissueRows =
        expression.coverage === "available"
            ? expression.data.tissues
                  .filter((t) => meetsTpmFloor(t.tissueLabel, t.value ?? 0) && isSafetyRelevant(t.tissueLabel, t.organSystem))
                  .map((t) => ({
                      tissue: t.tissueLabel,
                      organ: t.organSystem ?? "unspecified",
                      tpm: t.value ?? 0,
                  }))
            : [];

    const drugsForTractability: DrugForTractability[] = enrichedModulators.map((m) => ({
        drug_id: m.moleculeChemblId,
        drug_name: m.preferredName,
        molecule_type: m.moleculeType,
        max_phase: m.maxPhase,
    }));
    const tractabilitySection = assembleTractability(resolved, ot, drugsForTractability);
    const preferredModality = tractabilitySection.coverage === "available" ? tractabilitySection.data.preferred_modality : null;
    const liabilitySummary = assembleLiabilitySummary(phase2, {
        offTargetRows,
        preferredModality,
    });

    const allRowCandidates = filteredIndications.slice(0, 50).map((a) => {
        const sources = [
            a.geneticAssociationScore != null ? "ot_genetics" : null,
            a.knownDrugScore != null ? "ot_known_drug" : null,
            a.animalModelScore != null ? "ot_animal_model" : null,
            a.somaticMutationScore != null ? "ot_somatic_mutation" : null,
            a.literatureScore != null ? "literature" : null,
        ].filter((s): s is string => s !== null);
        const evidence = makeAssociationEvidence(a);
        return { a, sources, evidence };
    });

    const supportedCandidates = allRowCandidates.filter(({ sources, evidence }) => sources.length > 0 || evidence.length > 0);
    const unsupportedCandidates = allRowCandidates.filter(({ sources, evidence }) => sources.length === 0 && evidence.length === 0);

    const indicationRows = supportedCandidates.map(({ a, sources, evidence }) => {
        const uniquePaperCount = a.literaturePmids?.length ?? 0;
        const { composite, breakdown } = indicationCompositeScore(a.score, sources, uniquePaperCount);
        return {
            disease_id: a.diseaseId,
            disease_name: a.diseaseName,
            composite_score: composite,
            composite_score_breakdown: breakdown,
            evidence_score: a.score,
            source_count: sources.length,
            unique_paper_count: uniquePaperCount,
            sources,
            evidence,
        };
    });

    // Run partitionTrialsByAttribution on active trials first to detect off-target
    // before building clinical_development.trials and discovery_trials sections.
    // Since ctgov interventions are plain strings (no ChEMBL IDs), the resolver
    // cannot fire and all trials land in primary — off-target detection activates
    // only when ChEMBL IDs are available downstream.
    const activeTrialsPartitioned = ctgov.coverage === "available" ? await partitionTrialsByAttribution(ctgov.data.active, attrCtx) : null;

    // Map ctgov active trials to clinical-trial row shape with text-based confidence,
    // then remove rows identified as off-target by the attribution filter.
    // Drug-in-class matches (calcitonin drugs for CALCR, GLP-1 drugs for GLP1R, etc.)
    // are promoted to "medium" via classifyClinicalTrialConfidence so they survive
    // the ≥ medium threshold even when the gene symbol is absent from intervention names.
    const clinicalTrialRows =
        activeTrialsPartitioned !== null
            ? activeTrialsPartitioned.primary
                  .map((t) => {
                      const text_confidence = classifyClinicalTrialConfidence(t, resolved.geneSymbol, knownClassDrugNames);
                      return {
                          nct_id: t.nctId,
                          title: t.title,
                          phase: t.phase,
                          status: t.status,
                          conditions: t.conditions,
                          start_date: t.startDate,
                          completion_date: t.primaryCompletionDate,
                          match_confidence: text_confidence,
                      };
                  })
                  .filter((r) => r.match_confidence !== "low")
            : null;

    // Build failed-trial rows with off-target partitioning. The gene-symbol
    // query in collectCtgov misses terminated trials whose intervention is
    // recorded only by sponsor code or brand name (e.g., SMC021 for oral
    // salmon calcitonin), so we supplement with a drug-name query against
    // CT.gov keyed by the assembled drug interactions. The function self-
    // throttles via withHost("ctgov", ...) on its per-drug call, so the
    // assembler does not need its own outer wrapper. Per-drug failures
    // inside searchFailedTrialsForDrugNames are isolated.
    const drugNameFailedTrials =
        drugInteractionRows && drugInteractionRows.length > 0
            ? await searchFailedTrialsForDrugNames(drugInteractionRows.map((d) => d.drug_name).filter(Boolean))
                  .then((r) => r.trials)
                  .catch(() => [])
            : [];

    const failedById = new Map<string, { nctId: string; title: string; interventions: string[]; conditions: string[] }>();
    if (ctgov.coverage === "available") {
        for (const t of ctgov.data.failed) {
            failedById.set(t.nctId, {
                nctId: t.nctId,
                title: t.title,
                interventions: t.interventions,
                conditions: t.conditions,
            });
        }
    }
    for (const t of drugNameFailedTrials) {
        if (!failedById.has(t.nctId)) {
            failedById.set(t.nctId, {
                nctId: t.nctId,
                title: t.title,
                interventions: t.interventions,
                conditions: t.conditions,
            });
        }
    }
    const rawFailedTrials = [...failedById.values()].map((t) => {
        const fanoutItem = fanout?.perTrialAes.results.find((r) => r.coverage === "available" && r.data.nctId === t.nctId);
        const whyStopped = fanoutItem?.coverage === "available" ? (fanoutItem.data.whyStopped ?? "") : "";
        return {
            nctId: t.nctId,
            title: t.title,
            interventions: t.interventions,
            conditions: t.conditions,
            why_stopped: whyStopped,
            failure_category: buildFailureCategoryDiscriminated(whyStopped),
            classifier: "rules" as const,
        };
    });

    const failedTrialsPartitioned = rawFailedTrials.length > 0 ? await partitionTrialsByAttribution(rawFailedTrials, attrCtx) : null;

    const failedTrialRows =
        failedTrialsPartitioned?.primary.map((t) => ({
            nct_id: t.nctId,
            title: t.title,
            why_stopped: t.why_stopped,
            failure_category: t.failure_category,
            classifier: t.classifier,
        })) ?? [];

    const failedRelatedRows =
        failedTrialsPartitioned?.related.map((t) => ({
            nct_id: t.nctId,
            title: t.title,
            why_stopped: t.why_stopped,
            failure_category: t.failure_category,
            classifier: t.classifier,
        })) ?? [];

    // Typed explicitly so literal string coverage values narrow correctly.
    // Phase-5 persist attaches the derived sub-tree after synthesis is stamped.
    const dossierBody: DossierV4Body = {
        schema_version: "4",
        generated_at: new Date().toISOString(),
        entity: assembleEntity(resolved),
        liability_summary: liabilitySummary,
        tractability: tractabilitySection,
        indications:
            ot.coverage === "available"
                ? {
                      coverage: "available" as const,
                      data: {
                          rows: indicationRows,
                          excluded_unsupported_count: unsupportedCandidates.length,
                          ...(unsupportedCandidates.length > 0
                              ? {
                                    unsupported_associations: unsupportedCandidates.map(({ a }) => ({
                                        disease_id: a.diseaseId,
                                        disease_name: a.diseaseName,
                                    })),
                                }
                              : {}),
                      },
                  }
                : {
                      coverage: "queried_no_data" as const,
                      error: {
                          message: ot.coverage === "queried_no_data" && ot.error?.message ? ot.error.message : "Open Targets unavailable",
                      },
                  },
        drug_interactions: drugInteractionRows
            ? { coverage: "available", data: { rows: drugInteractionRows } }
            : { coverage: "queried_no_data", error: { message: "no ChEMBL modulators available" } },
        clinical_development: {
            trials:
                clinicalTrialRows === null
                    ? { coverage: "queried_no_data" as const, error: { message: "ClinicalTrials.gov unavailable" } }
                    : (() => {
                          const base = coverageFromRows(clinicalTrialRows, { reason: "no trials matched the assessment target with confidence ≥ medium" });
                          if (base.coverage !== "available") return base;
                          return {
                              coverage: "available" as const,
                              data: {
                                  rows: base.data.rows,
                                  selection_criteria: {
                                      derived_from: "analytics.discovery_trials" as const,
                                      min_confidence: "medium" as const,
                                      excluded_off_target_count: activeTrialsPartitioned?.related.length ?? 0,
                                  },
                                  ...(activeTrialsPartitioned && activeTrialsPartitioned.related.length > 0
                                      ? {
                                            related_target_trials: activeTrialsPartitioned.related.map((t) => ({
                                                nct_id: t.nctId,
                                                title: t.title,
                                                phase: t.phase,
                                                status: t.status,
                                                conditions: t.conditions,
                                                start_date: t.startDate,
                                                completion_date: t.primaryCompletionDate,
                                                match_confidence: "off_target" as const,
                                            })),
                                            related_receptor: activeTrialsPartitioned.related_receptor,
                                        }
                                      : {}),
                              },
                          };
                      })(),
            outcomes: trialOutcomesRows
                ? { coverage: "available", data: { rows: trialOutcomesRows } }
                : phase3
                  ? { coverage: "queried_no_data", error: { message: "no per-trial outcomes available" } }
                  : { coverage: "not_loaded", reason: "Phase-3 fan-out not run" },
            failed_trials:
                ctgov.coverage === "available"
                    ? {
                          coverage: "available" as const,
                          data: {
                              rows: failedTrialRows,
                              ...(failedRelatedRows.length > 0
                                  ? {
                                        related_target_trials: failedRelatedRows,
                                        related_receptor: failedTrialsPartitioned?.related_receptor,
                                    }
                                  : {}),
                          },
                      }
                    : { coverage: "queried_no_data" as const },
            benchmarks: {
                therapeutic_area: benchmarks.therapeutic_area,
                fallback_to_all_areas: benchmarks.source === "fallback",
                phase_transitions: benchmarks.transitions as unknown as Record<string, number>,
                likelihood_of_approval: benchmarks.transitions.phase1_to_approval,
                source_attribution: `${datasetAttr.source} (${datasetAttr.data_version}, ${datasetAttr.data_window})`,
            },
        },
        safety_profile: {
            organ_rollup: organRollupRows
                ? { coverage: "available", data: { rows: organRollupRows } }
                : phase3
                  ? { coverage: "queried_no_data", error: { message: "no organ-level signals" } }
                  : { coverage: "not_loaded", reason: "Phase-3 fan-out not run" },
            faers: (() => {
                const classPrecedentSection = classP
                    ? { coverage: "available" as const, data: classP }
                    : phase3
                      ? { coverage: "queried_no_data" as const, error: { message: "no class precedent data" } }
                      : { coverage: "not_loaded" as const, reason: "Phase-3 fan-out not run" };
                const rawFaers = faersAgg
                    ? { coverage: "available" as const, data: faersAgg }
                    : phase3
                      ? { coverage: "queried_no_data" as const, error: { message: "FAERS returned no reports" } }
                      : { coverage: "not_loaded" as const, reason: "Phase-3 fan-out not run" };
                return reconcileFaersCoverage({ faers: rawFaers, class_precedent: classPrecedentSection });
            })(),
            trial_aes: trialAesAgg
                ? { coverage: "available", data: trialAesAgg }
                : phase3
                  ? { coverage: "queried_no_data", error: { message: "no trial AE data" } }
                  : { coverage: "not_loaded", reason: "Phase-3 fan-out not run" },
            off_target_panel: offTargetPanel
                ? { coverage: "available", data: offTargetPanel }
                : phase3
                  ? { coverage: "queried_no_data", error: { message: "no off-target data" } }
                  : { coverage: "not_loaded", reason: "Phase-3 fan-out not run" },
            failed_trials_safety_lens:
                ctgov.coverage === "available" && failedTrialRows.length > 0
                    ? {
                          coverage: "available" as const,
                          data: {
                              rows: failedTrialRows,
                              ...(failedRelatedRows.length > 0
                                  ? {
                                        related_target_trials: failedRelatedRows,
                                        related_receptor: failedTrialsPartitioned?.related_receptor,
                                    }
                                  : {}),
                          },
                      }
                    : ctgov.coverage === "available"
                      ? { coverage: "queried_no_data" as const, error: { message: "no failed trials" } }
                      : { coverage: "queried_no_data" as const, error: { message: "ClinicalTrials.gov unavailable" } },
            class_precedent: classP
                ? { coverage: "available", data: classP }
                : phase3
                  ? { coverage: "queried_no_data", error: { message: "no class precedent data" } }
                  : { coverage: "not_loaded", reason: "Phase-3 fan-out not run" },
            target_organ_liabilities: [],
            regulatory_actions:
                regulatoryActionRows.length > 0
                    ? { coverage: "available" as const, data: { rows: regulatoryActionRows } }
                    : { coverage: "queried_no_data" as const },
        },
        off_tissue_risk: expression.coverage === "available" ? { coverage: "available", data: { rows: offTissueRows } } : { coverage: "queried_no_data" },
        off_target_panel: offTargetPanel
            ? { coverage: "available", data: offTargetPanel }
            : phase3
              ? { coverage: "queried_no_data", error: { message: "no off-target data" } }
              : { coverage: "not_loaded", reason: "Phase-3 fan-out not run" },
        reference_biology: {
            therapeutic_area_associations:
                ot.coverage === "available"
                    ? {
                          coverage: "available",
                          data: {
                              rows: filteredIndications.slice(0, 200).map((a) => {
                                  const evidence = makeAssociationEvidence(a);
                                  return {
                                      partner_id: a.diseaseId,
                                      partner_name: a.diseaseName,
                                      predicate:
                                          a.geneticAssociationScore != null
                                              ? "associated_with"
                                              : a.knownDrugScore != null
                                                ? "therapeutic_target"
                                                : a.animalModelScore != null
                                                  ? "validated_in_animal_model"
                                                  : "literature_co_occurrence",
                                      best_score: a.score,
                                      source_count: [
                                          a.geneticAssociationScore,
                                          a.knownDrugScore,
                                          a.animalModelScore,
                                          a.somaticMutationScore,
                                          a.literatureScore,
                                      ].filter((s) => s != null).length,
                                      paper_count: a.literaturePmids?.length ?? 0,
                                      evidence,
                                  };
                              }),
                          },
                      }
                    : { coverage: "queried_no_data" },
            molecular_interactions: (() => {
                const rows = assembleMolecularInteractions(phase2, fanout);
                return rows ? { coverage: "available" as const, data: { rows } } : { coverage: "queried_no_data" as const };
            })(),
            biomarker_potential: (() => {
                const rows = assembleBiomarkerPotential(phase2);
                return rows ? { coverage: "available" as const, data: { rows } } : { coverage: "queried_no_data" as const };
            })(),
            genetic_alterations: {
                somatic:
                    cbioportal.coverage === "available"
                        ? coverageFromRows(
                              cbioportal.data.rows.map((r) => ({
                                  cancer_type: r.cancerTypeName,
                                  cohort: r.studies.join(", "),
                                  mutation_count: r.mutatedSamples,
                                  total_samples: r.totalSamples,
                                  frequency: r.frequency,
                                  source: "cbioportal" as const,
                              })),
                              { reason: "cBioPortal returned no somatic mutation cohorts for this gene" },
                          )
                        : { coverage: "queried_no_data" as const },
                clinvar:
                    clinvar.coverage === "available"
                        ? coverageFromRows(
                              clinvar.data.variants.map((v) => ({
                                  variant_id: v.variationId,
                                  hgvs: v.title,
                                  classification: v.clinicalSignificance,
                                  condition: v.conditions[0] ?? "",
                                  review_status: v.reviewStatus,
                              })),
                              { reason: "ClinVar returned 0 variants for this gene" },
                          )
                        : { coverage: "queried_no_data" as const },
            },
            resistance_evidence: (() => {
                const rows = assembleResistanceEvidence(phase2);
                return rows ? { coverage: "available" as const, data: { rows } } : { coverage: "queried_no_data" as const };
            })(),
            combination_evidence: (() => {
                const rows = assembleCombinationEvidence(phase2);
                return rows ? { coverage: "available" as const, data: { rows } } : { coverage: "queried_no_data" as const };
            })(),
            pathway_context:
                pathways.coverage === "available"
                    ? (() => {
                          const presentDbs = new Set(pathways.data.pathways.map((p) => p.source));
                          const ALL_DBS = ["reactome", "kegg", "wikipathways", "msigdb"];
                          const QUERIED = ["reactome", "kegg"];
                          return {
                              coverage: "available" as const,
                              data: {
                                  rows: pathways.data.pathways.map((p) => ({
                                      pathway_id: p.id,
                                      pathway_name: p.name,
                                      database: p.source,
                                      evidence_score: 1,
                                  })),
                                  databases_queried:
                                      QUERIED.filter((db) => presentDbs.has(db as "kegg" | "reactome")).length === QUERIED.length
                                          ? QUERIED
                                          : QUERIED.filter((db) => presentDbs.has(db as "kegg" | "reactome")),
                                  databases_skipped: ALL_DBS.filter((db) => !presentDbs.has(db as "kegg" | "reactome")),
                              },
                          };
                      })()
                    : { coverage: "queried_no_data" },
            ppi_network:
                ppi.coverage === "available"
                    ? {
                          coverage: "available",
                          data: { partners: dedupePpiPartners(ppi.data.partners) },
                      }
                    : { coverage: "queried_no_data" },
            normal_tissue_expression:
                expression.coverage === "available"
                    ? {
                          coverage: "available",
                          data: {
                              source: expression.data.source,
                              unit: expression.data.unit,
                              normalization_notes: expression.data.normalization_notes,
                              rows: expression.data.tissues
                                  .filter((t) => t.value != null)
                                  .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
                                  .map((t) => ({
                                      tissue: t.tissueLabel,
                                      value: t.value ?? 0,
                                  })),
                          },
                      }
                    : { coverage: "queried_no_data" },
            preclinical: {
                ko_phenotype:
                    impc.coverage === "available"
                        ? {
                              coverage: "available",
                              data: {
                                  marker_symbol: impc.data.mouseMarkerSymbol,
                                  viability: impc.data.viability,
                                  sex_dimorphism: impc.data.sexDimorphic,
                                  organ_systems_with_phenotype: impc.data.organSystems,
                                  top_mp_terms: impc.data.mpTerms.slice(0, 25).map((m) => m.term),
                                  total_phenotype_count: impc.data.phenotypeCount,
                                  pre_weaning_lethal: impc.data.viability === "lethal_pre_weaning",
                                  supporting_literature: koSupportingLiterature,
                              },
                          }
                        : { coverage: "queried_no_data" },
                expression_heatmap:
                    expressionMulti.coverage === "available"
                        ? {
                              coverage: "available",
                              data: {
                                  cells: expressionMulti.data.bySpecies.flatMap((s) => {
                                      const speciesKey =
                                          s.species === "homo_sapiens"
                                              ? ("human" as const)
                                              : s.species === "mus_musculus"
                                                ? ("mouse" as const)
                                                : s.species === "rattus_norvegicus"
                                                  ? ("rat" as const)
                                                  : s.species === "macaca_mulatta"
                                                    ? ("macaque" as const)
                                                    : ("dog" as const);
                                      return s.tissues.map((t) => ({
                                          tissue: t.tissue,
                                          species: speciesKey,
                                          rank: t.rank,
                                      }));
                                  }),
                                  per_species_coverage: Object.fromEntries(
                                      expressionMulti.data.bySpecies.map((s) => [
                                          s.species,
                                          s.tissues.length > 0 ? ("available" as const) : ("queried_no_data" as const),
                                      ]),
                                  ),
                              },
                          }
                        : { coverage: "queried_no_data" },
                translational_commentary: {
                    coverage: "not_loaded",
                    reason: NOT_LOADED_PHASE5,
                },
                preclinical_literature: preclinicalLitData
                    ? { coverage: "available", data: preclinicalLitData }
                    : { coverage: "queried_no_data", error: { message: "no species-tagged literature" } },
                data_coverage: {
                    ko: impc.coverage === "available" ? "available" : "queried_no_data",
                    expression: expressionMulti.coverage,
                    literature: pubmed.coverage,
                    per_species:
                        expressionMulti.coverage === "available"
                            ? Object.fromEntries(expressionMulti.data.bySpecies.map((s) => [s.species, s.tissues.length > 0]))
                            : {},
                },
            },
            key_papers: keyPapersRows
                ? { coverage: "available", data: { rows: keyPapersRows } }
                : { coverage: "queried_no_data", error: { message: "no PubMed results" } },
        },
        analytics: {
            evidence_conflicts: (() => {
                const rows = assembleEvidenceConflicts(phase2);
                return rows ? { coverage: "available" as const, data: { rows } } : { coverage: "queried_no_data" as const };
            })(),
            evidence_timeline: evidenceTimeline
                ? { coverage: "available", data: evidenceTimeline }
                : pubmed.coverage === "not_loaded"
                  ? { coverage: "not_loaded", reason: "PubMed not queried" }
                  : { coverage: "queried_no_data", error: { message: "no PubMed years available" } },
            translational_chain: translationalChain
                ? { coverage: "available", data: translationalChain }
                : pubmed.coverage === "not_loaded" && ctgov.coverage === "not_loaded" && impc.coverage === "not_loaded"
                  ? { coverage: "not_loaded", reason: "no upstream tier evidence" }
                  : { coverage: "queried_no_data", error: { message: "no tier evidence" } },
            additional_evidence: (() => {
                const data = assembleAdditionalEvidence(phase2);
                return data ? { coverage: "available" as const, data } : { coverage: "queried_no_data" as const };
            })(),
            discovery_trials: discoveryTrialData
                ? { coverage: "available" as const, data: discoveryTrialData }
                : { coverage: "queried_no_data" as const, error: { message: "no medium/low-confidence trials" } },
            // Stamped by Phase 5 after synthesis agents run; not available at assembly time.
            synthesis_diagnostics: { coverage: "not_loaded", reason: "Phase-5 synthesis not yet run" },
        },
        // Stamped by Phase 5 after the dossier-recommendation agent runs.
        executive_recommendation: { coverage: "not_loaded", reason: "Phase-5 synthesis not yet run" },
    };

    return dossierBody;
}

// ── FAERS coverage reconciliation ───────────────────────────────────

type ReconcileFaersClassPrecedent =
    | {
          coverage?: "available" | "queried_no_data" | "not_loaded";
          data?: {
              per_organ?: Array<{
                  organ?: string;
                  top_aes?: Array<{ term?: string; report_count?: number }>;
              }>;
              drugs_in_class?: Array<{ drug_id?: string; drug_name?: string }>;
          };
      }
    | undefined;

type ReconcileFaersOutput = {
    coverage: "available";
    data: {
        total_reports: number;
        seriousness: { coverage: "queried_no_data"; total_reports: number };
        top_signals: Array<{ meddra_term: string; organ?: string; report_count: number }>;
        per_modulator: Array<{ modulator: string; modulator_id: string | null; report_count: number; coverage: "queried_no_data" }>;
    };
    error?: { message: string };
    inference_path: string;
};

/**
 * Reconciles target-level FAERS with class_precedent aggregates.
 *
 * When target-level FAERS has data (coverage: "available"), pass through
 * unchanged. When class_precedent has FAERS-derived reports in per_organ,
 * fold them into a class-scoped FaersSummaryV4 payload with
 * coverage: "available" and inference_path tagged — rather than leaving
 * the section as queried_no_data, which creates an evidence conflict
 * that the conflict-detector flags. When neither has data, return
 * faers unchanged.
 */
export function reconcileFaersCoverage<
    TFaers extends {
        coverage: "available" | "queried_no_data" | "not_loaded";
        error?: { message: string };
        reason?: string;
    },
>(input: { faers: TFaers; class_precedent: ReconcileFaersClassPrecedent }): TFaers | ReconcileFaersOutput {
    const { faers, class_precedent: classPrecedent } = input;

    // Target-level FAERS already has data — identity pass-through.
    if (faers.coverage === "available") return faers;

    if (!classPrecedent || classPrecedent.coverage === "queried_no_data" || classPrecedent.coverage === "not_loaded") return faers;

    const perOrgan = classPrecedent.data?.per_organ ?? [];
    const aes = perOrgan.flatMap((po) =>
        (po.top_aes ?? []).map((ae) => ({
            meddra_term: ae.term ?? "",
            organ: po.organ,
            report_count: ae.report_count ?? 0,
        })),
    );

    // No class-level AEs either — leave the section as-is.
    if (aes.length === 0) return faers;

    // Each AE-term count in top_aes counts reports that have that specific AE.
    // A report with multiple AEs (e.g. NAUSEA + DIZZINESS) contributes to each
    // term's count, so this sum is an upper bound on unique reports, not the
    // true unique count. The class_precedent structure does not preserve unique
    // report counts — this is the best approximation available.
    const total = aes.reduce((s, ae) => s + ae.report_count, 0);

    return {
        coverage: "available" as const,
        data: {
            total_reports: total,
            seriousness: { coverage: "queried_no_data" as const, total_reports: total },
            top_signals: aes
                .slice()
                .sort((a, b) => b.report_count - a.report_count)
                .slice(0, 20),
            // class_precedent.per_organ aggregates across drugs without preserving
            // per-drug report counts. Emitting per_modulator entries with
            // report_count: 0 would look like real measured zeros to any consumer
            // summing them to cross-check total_reports. Returning an empty array
            // is the honest representation — the per-drug breakdown is not known
            // at this layer.
            per_modulator: [],
        },
        inference_path: "class_precedent.per_organ → FAERS",
    };
}
