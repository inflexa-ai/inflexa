/**
 * The safety-evidence corroboration spine.
 *
 * A run queries a dozen-plus independent sources and files each one's output in
 * its own dossier section. This fold asks the question none of those sections
 * can: for a given organ, do the sources agree? Agreement across independent
 * sources is itself evidence, and it is what separates a real organ liability
 * from a single-source artefact.
 *
 * The fold re-fetches nothing. Every signal it reads is already in hand when it
 * runs, and a source that also populates a section of its own is referenced
 * here as a contribution rather than restated — there is one evidence path, not
 * two.
 *
 * **The source list is open.** A source is one entry in `SIGNAL_SOURCES`
 * declaring its id and how to read its signals out of the run's inputs.
 * Everything downstream — grouping, counting, thresholding, evidence assembly —
 * is written against the id-bearing record, so a fifteenth collector joins the
 * spine by adding an entry and changes neither the fold nor the schema.
 */

import type { OrganSystem } from "../../../contracts/organ-system.js";
import type { ClaimEvidence, OrganCorroborationRow, OrganSignalContribution, SafetyCorroboration } from "@inflexa-ai/harness/contracts/target-dossier.js";
import { isSafetyRelevant, meetsTpmFloor, resolveTissueOrganSystem } from "../assemblers/safety.js";
import type { Phase1Bundle } from "../schemas.js";
import type { OrganSignalProjection } from "./fda-label-safety.js";
import { resolveHpoOrgan } from "./hpo-organ-map.js";
import { resolveImpcOrgan } from "./impc-organ-map.js";
import { classifyOrgan } from "./meddra-organ-map.js";

/** Distinct sources an organ needs before the spine calls it corroborated. */
export const MIN_INDEPENDENT_SOURCES = 2;

/** What the section reports as having emptied it. */
export const CORROBORATION_FILTER =
    `organ signals with no resolvable organ or locator, or whose organ drew fewer than ` + `${MIN_INDEPENDENT_SOURCES} independent sources`;

/**
 * Curated human phenotypes ranked per organ. A well-annotated gene carries
 * hundreds of HPO terms under one organ system; beyond the ranked head they
 * restate the same organ-level signal, so the source raises it once at the
 * granularity a reader can act on.
 */
const PHENOTYPES_PER_ORGAN = 3;

/** Everything the fold reads. Already collected — nothing here is fetched. */
export interface CorroborationInput {
    readonly phase1: Phase1Bundle;
    /** Per-organ FDA label warnings segmented at the approval-precedent step. */
    readonly regulatoryOrganSignals: OrganSignalProjection | null;
}

/**
 * One source's raw signal, before admission.
 *
 * `organ` is null when the source's own vocabulary did not resolve onto a
 * canonical organ, and `evidence` is null when the source could not produce a
 * locator. Either makes the signal inadmissible — the fold counts it rather
 * than filing it under a neighbouring organ or asserting it unevidenced.
 */
interface RawOrganSignal {
    readonly organ: OrganSystem | null;
    readonly signal: string;
    readonly evidence: ClaimEvidence | null;
}

interface SignalSource {
    readonly id: string;
    readonly extract: (input: CorroborationInput) => RawOrganSignal[];
}

// ── Source extractors ────────────────────────────────────────────────

/** Warning fragments from FDA prescribing information, already organ-keyed. */
function extractRegulatoryLabels(input: CorroborationInput): RawOrganSignal[] {
    const projection = input.regulatoryOrganSignals;
    if (!projection) return [];
    return projection.signals.map((s) => ({
        organ: s.organ,
        signal: `${s.drug_name} label §${s.label_section}: ${s.excerpt}`,
        evidence: s.evidence.regulatory_reference ? (s.evidence as ClaimEvidence) : null,
    }));
}

/** Mouse knockout phenotype systems, keyed by the MGI accession for the gene. */
function extractKnockoutPhenotypes(input: CorroborationInput): RawOrganSignal[] {
    const impc = input.phase1.collectors.impc;
    if (impc.coverage !== "available") return [];
    const accession = impc.data.mgiAccessionId;
    return impc.data.organSystems.map((bucket) => ({
        organ: resolveImpcOrgan(bucket),
        signal: `mouse knockout phenotype in the ${bucket} system`,
        evidence: accession
            ? {
                  source: "impc",
                  accession,
                  predicate: "knockout_phenotype",
                  excerpt: `${impc.data.mouseMarkerSymbol ?? ""} knockout phenotypes in the ${bucket} system`.trim(),
                  metadata: { bucket, phenotype_count: impc.data.phenotypeCount },
              }
            : null,
    }));
}

/** Curated human phenotypes, resolved by HPO ancestry rather than by label. */
function extractHumanPhenotypes(input: CorroborationInput): RawOrganSignal[] {
    const monarch = input.phase1.collectors.monarch;
    if (monarch.coverage !== "available") return [];

    const ranked = [...monarch.data.phenotypes].sort(
        (a, b) => b.publications.length - a.publications.length || (b.frequencyPercent ?? 0) - (a.frequencyPercent ?? 0) || a.label.localeCompare(b.label),
    );

    const perOrgan = new Map<OrganSystem, number>();
    const out: RawOrganSignal[] = [];
    for (const p of ranked) {
        const organ = resolveHpoOrgan(p.hpoId, p.ancestorIds);
        if (organ === null) {
            out.push({ organ: null, signal: p.label, evidence: null });
            continue;
        }
        const seen = perOrgan.get(organ) ?? 0;
        if (seen >= PHENOTYPES_PER_ORGAN) continue;
        perOrgan.set(organ, seen + 1);
        const pmid = p.publications.find((pub) => pub.startsWith("PMID:"))?.slice("PMID:".length);
        out.push({
            organ,
            signal: `curated human phenotype: ${p.label}`,
            evidence: {
                source: "monarch",
                accession: p.hpoId,
                ...(pmid ? { pmid } : {}),
                predicate: "human_phenotype",
                is_human: true,
                excerpt: p.label,
                metadata: {
                    ...(p.diseaseContext ? { disease_context: p.diseaseContext } : {}),
                    ...(p.frequencyPercent != null ? { frequency_percent: p.frequencyPercent } : {}),
                    ...(p.primaryKnowledgeSource ? { knowledge_source: p.primaryKnowledgeSource } : {}),
                },
            },
        });
    }
    return out;
}

/** Open Targets' curated safety liabilities, keyed by the Ensembl accession. */
function extractCuratedSafetyLiabilities(input: CorroborationInput): RawOrganSignal[] {
    const ot = input.phase1.collectors.opentargets;
    if (ot.coverage !== "available") return [];
    return ot.data.safetyLiabilities.map((liability) => ({
        organ: classifyOrgan(liability.event) ?? classifyOrgan(liability.biosamples.join(" ")),
        signal: `curated safety liability: ${liability.event}`,
        evidence: {
            source: "opentargets:safety",
            accession: ot.data.ensemblId,
            predicate: "known_safety_liability",
            excerpt: liability.effects ? `${liability.event} — ${liability.effects}` : liability.event,
            metadata: { biosamples: liability.biosamples, curator: liability.source },
        },
    }));
}

/**
 * Baseline expression in safety-relevant tissues.
 *
 * The atlas reaches the dossier through Open Targets' consensus expression,
 * which is Human Protein Atlas data — the same path
 * `reference_biology.normal_tissue_expression` and the off-tissue risk rows
 * read, with the same safety-relevance and floor rules applied. Only the
 * highest-expressing tissue per organ is raised: several tissues mapping to one
 * organ are one expression signal about that organ.
 */
function extractExpressionAtlas(input: CorroborationInput): RawOrganSignal[] {
    const expression = input.phase1.collectors.expressionHuman;
    if (expression.coverage !== "available") return [];
    const accession = input.phase1.resolved.ids.ensembl;

    const best = new Map<OrganSystem, { tissue: string; value: number }>();
    const unresolved: RawOrganSignal[] = [];
    for (const t of expression.data.tissues) {
        const value = t.value ?? 0;
        if (!isSafetyRelevant(t.tissueLabel, t.organSystem) || !meetsTpmFloor(t.tissueLabel, value)) continue;
        const organ = resolveTissueOrganSystem(t.tissueLabel, t.organSystem);
        if (organ === null) {
            unresolved.push({ organ: null, signal: `${t.tissueLabel} expression`, evidence: null });
            continue;
        }
        const current = best.get(organ);
        if (!current || value > current.value) best.set(organ, { tissue: t.tissueLabel, value });
    }

    const resolved = [...best.entries()].map(([organ, hit]): RawOrganSignal => {
        const signal = `${expression.data.unit} expression ${hit.value} in ${hit.tissue}`;
        return {
            organ,
            signal,
            evidence: accession
                ? {
                      source: `expression:${expression.data.source}`,
                      accession,
                      predicate: "expressed_in_safety_tissue",
                      score: hit.value,
                      excerpt: `${hit.tissue}: ${hit.value} (${expression.data.unit})`,
                      metadata: {
                          tissue: hit.tissue,
                          unit: expression.data.unit,
                          normalization_notes: expression.data.normalization_notes,
                      },
                  }
                : null,
        };
    });
    return [...resolved, ...unresolved];
}

/**
 * The registered sources.
 *
 * This array is the whole integration surface: an id, and how to read that
 * source's organ-bearing signals out of what the run already collected.
 */
const SIGNAL_SOURCES: readonly SignalSource[] = [
    { id: "fda_label", extract: extractRegulatoryLabels },
    { id: "impc", extract: extractKnockoutPhenotypes },
    { id: "monarch", extract: extractHumanPhenotypes },
    { id: "opentargets_safety", extract: extractCuratedSafetyLiabilities },
    { id: "expression_atlas", extract: extractExpressionAtlas },
];

// ── The fold ─────────────────────────────────────────────────────────

interface AdmittedSignal {
    readonly source: string;
    readonly organ: OrganSystem;
    readonly contribution: OrganSignalContribution;
}

/**
 * Fold the run's per-organ safety signals into one corroboration record per
 * organ.
 *
 * `dropped_count` counts signals — the fold's input unit — discarded because
 * their organ did not resolve, because their source produced no locator, or
 * because their organ drew fewer than `MIN_INDEPENDENT_SOURCES` distinct
 * sources. A fold that ends with no record reports `filtered` with that count
 * rather than an empty `available`.
 */
export function assembleSafetyCorroboration(input: CorroborationInput): SafetyCorroboration {
    const sourcesConsidered: string[] = [];
    const admitted: AdmittedSignal[] = [];
    let dropped = 0;

    for (const source of SIGNAL_SOURCES) {
        const signals = source.extract(input);
        if (signals.length === 0) continue;
        sourcesConsidered.push(source.id);

        const seen = new Set<string>();
        for (const raw of signals) {
            if (raw.organ === null || raw.evidence === null) {
                dropped += 1;
                continue;
            }
            const key = `${raw.organ} ${raw.signal}`;
            if (seen.has(key)) continue;
            seen.add(key);
            admitted.push({
                source: source.id,
                organ: raw.organ,
                contribution: { source: source.id, signal: raw.signal, evidence: raw.evidence },
            });
        }
    }

    if (sourcesConsidered.length === 0) {
        return {
            coverage: "queried_no_data",
            error: { message: "no source produced an organ-bearing safety signal" },
        };
    }

    const byOrgan = new Map<OrganSystem, AdmittedSignal[]>();
    for (const item of admitted) {
        const bucket = byOrgan.get(item.organ);
        if (bucket) bucket.push(item);
        else byOrgan.set(item.organ, [item]);
    }

    const rows: OrganCorroborationRow[] = [];
    for (const [organ, items] of byOrgan) {
        const corroborating = [...new Set(items.map((i) => i.source))].sort();
        if (corroborating.length < MIN_INDEPENDENT_SOURCES) {
            dropped += items.length;
            continue;
        }
        const contributions = items.map((i) => i.contribution);
        rows.push({
            organ,
            contributions,
            corroborating_sources: corroborating,
            independent_source_count: corroborating.length,
            support: { state: "scored", evidence: contributions.map((c) => c.evidence) },
        });
    }

    rows.sort((a, b) => b.independent_source_count - a.independent_source_count || a.organ.localeCompare(b.organ));

    if (rows.length === 0) {
        if (dropped === 0) {
            return {
                coverage: "queried_no_data",
                error: { message: "no source produced an organ-bearing safety signal" },
            };
        }
        return { coverage: "filtered", filter: CORROBORATION_FILTER, dropped_count: dropped };
    }

    return {
        coverage: "available",
        data: {
            rows,
            sources_considered: [...sourcesConsidered].sort(),
            min_independent_sources: MIN_INDEPENDENT_SOURCES,
        },
        ...(dropped > 0 ? { dropped_count: dropped } : {}),
    };
}
