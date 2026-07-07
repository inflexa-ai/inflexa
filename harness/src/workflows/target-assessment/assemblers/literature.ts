import type { EvidenceItem } from "@inflexa-ai/harness/contracts/target-dossier.js";
import type { Phase2Bundle } from "../steps/phase2-aggregate.js";
import type { Phase3Bundle } from "../steps/phase3-aggregate.js";
import { classifyTrialAttribution } from "../lib/target-identity-filter.js";
import { HIGH_EXPRESSION_TPM_THRESHOLD } from "../lib/expression-constants.js";
export { HIGH_EXPRESSION_TPM_THRESHOLD };

// ── Shared helpers (pulled up so extracted functions can reference them) ──

const SAFETY_RELEVANT_ORGANS = new Set([
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

function isSafetyRelevant(tissue: string, organ?: string | null): boolean {
    const t = tissue.toLowerCase();
    const o = (organ ?? "").toLowerCase();
    for (const safe of SAFETY_RELEVANT_ORGANS) {
        if (t.includes(safe) || o.includes(safe)) return true;
    }
    return false;
}

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

type FanoutResults = Phase3Bundle["fanout"];

// ── Extracted content (lines 1544–2504, 2541–2678 from index.ts) ──────

const SPECIES_PATTERNS: Array<{ species: string; rx: RegExp }> = [
    { species: "mouse", rx: /\b(mouse|mice|murine)\b/i },
    { species: "rat", rx: /\brats?\b/i },
    { species: "macaque", rx: /\b(macaque|cynomolgus|rhesus)\b/i },
    { species: "dog", rx: /\b(canine|beagle)\b/i },
    { species: "human", rx: /\b(human|patient|cohort)\b/i },
];

const IN_VITRO_RX =
    /\b(organoid|spheroid|cell line|cell-line|primary cells?|cultured|culture|in vitro|cell culture|hipsc|ipsc|3d culture|microfluidic|chip|on a chip)\b/i;

function inferSpeciesFromTitle(title: string): { species: string; modelSystem: string } | null {
    let species: string | null = null;
    for (const p of SPECIES_PATTERNS) {
        if (p.rx.test(title)) {
            species = p.species;
            break;
        }
    }
    if (!species) return null;
    if (IN_VITRO_RX.test(title)) {
        return { species, modelSystem: "complex_in_vitro" };
    }
    return {
        species,
        modelSystem: species === "human" ? "ex_vivo_human" : "in_vivo_animal",
    };
}

export function assemblePreclinicalLiterature(phase2: Phase2Bundle) {
    const pubmed = phase2.phase1.collectors.pubmedIndex;
    if (pubmed.coverage !== "available") return null;
    const all = pubmed.data.results;
    const speciesRows = all
        .map((r) => {
            const inf = inferSpeciesFromTitle(r.title);
            if (!inf || inf.species === "human") return null;
            return {
                pmid: r.pmid,
                claim: r.title,
                excerpt: undefined,
                model_system: inf.modelSystem,
                species: inf.species,
            };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);
    const truncated = speciesRows.length > 50;
    const rows = speciesRows.slice(0, 50);
    if (rows.length === 0) return null;
    return {
        rows,
        total_claim_count: speciesRows.length,
        truncated,
    };
}

export function assembleKeyPapers(phase2: Phase2Bundle, internalRefCounts: Map<string, number>) {
    const pubmed = phase2.phase1.collectors.pubmedIndex;
    if (pubmed.coverage !== "available" || pubmed.data.results.length === 0) {
        return null;
    }
    const rows = pubmed.data.results.map((r) => {
        const yearNum = parseInt(r.year, 10);
        return {
            pmid: r.pmid,
            title: r.title,
            internal_reference_count: internalRefCounts.get(r.pmid) ?? 0,
            year: Number.isFinite(yearNum) ? yearNum : undefined,
        };
    });
    rows.sort((a, b) => b.internal_reference_count - a.internal_reference_count);
    return rows.slice(0, 25);
}

export function tallyInternalReferences(evidenceArrays: EvidenceItem[][]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const arr of evidenceArrays) {
        for (const e of arr) {
            if (e.pmid) counts.set(e.pmid, (counts.get(e.pmid) ?? 0) + 1);
        }
    }
    return counts;
}

// Loss-of-function literature signal — surface forms used in PubMed
// titles to describe knockout, knockdown, null/deficient mice, conditional
// alleles, CRISPR-mediated ablation, and homozygous-null notation. A title
// matches if any one pattern hits.
const KO_LITERATURE_PATTERNS: RegExp[] = [
    /\bknock[- ]?outs?\b/i,
    // Bare "knockdown" removed — too broad; siRNA/shRNA-mediated knockdown is
    // covered by the specific pattern below. Keeping it here admitted siRNA
    // cancer-cell-line papers that are not germline KO evidence.
    /\bconditional (?:ko|knock[- ]?out|deletion|ablation|allele)s?\b/i,
    /\b(?:gene|genetic|germline|somatic) (?:deletion|ablation|disruption|inactivation)\b/i,
    /\bnull (?:mice|mouse|allele|mutants?)\b/i,
    /\b[A-Za-z0-9]+[- ](?:deficient|null) (?:mice|mouse)\b/i,
    /\b(?:cre[/-]?lox(?:p)?|floxed|fl\/fl)\b/i,
    /\bcrispr(?:[/-]cas9?)?[- ]?(?:knock[- ]?out|deletion|ablation|mediated|edited)\b/i,
    /\b(?:loss[- ]of[- ]function|haploinsufficien(?:cy|t))\b/i,
    /\b(?:shrna|sirna|antisense oligonucleotide)[- ](?:mediated )?(?:knock[- ]?down|silencing|depletion)\b/i,
    /\bKO\b/, // case-sensitive: the bio abbreviation, not "ko" inside ordinary words
    /[-‐–−]\/[-‐–−]/, // -/- or unicode-dash homozygous-null notation
];

// Patterns that disqualify a title despite matching the inclusion list above.
//
// Bare "knockdown" and RNAi reagents (siRNA/shRNA) are excluded because they
// describe transient cell-line experiments, not germline or conditional KO models.
// Somatic LOF patterns (mutations/LOF in the context of cancer/tumour pathology)
// are excluded because they describe tumour-sequencing findings, not animal models.
// "/\bcancer\b/" and "/\btumou?r\b/" are intentionally NOT in this list: a
// legitimate paper such as "Tp53 KO mice are tumor-prone" mentions the tumour
// phenotype of the KO model and should remain included. We rely on the somatic
// context patterns (somatic+mutation, LOF+cancer) to catch sequencing papers.
const KO_EXCLUDE_PATTERNS: RegExp[] = [
    /\bsi[- ]?rna\b/i,
    /\bsh[- ]?rna\b/i,
    /\bknockdown\b/i,
    /\bsomatic\b.*\b(?:mutation|variant|loss[- ]of[- ]function)\b/i,
    /\bloss[- ]of[- ]function\b.*\b(?:cancer|tumou?r|glioblastoma|carcinoma|sarcoma|lymphoma|leukemia|melanoma)\b/i,
    /\b(?:cancer|tumou?r|glioblastoma|carcinoma|sarcoma|lymphoma|leukemia|melanoma)\b.*\bloss[- ]of[- ]function\b/i,
];

export function looksLikeKoLiterature(title: string): boolean {
    if (KO_EXCLUDE_PATTERNS.some((re) => re.test(title))) return false;
    return KO_LITERATURE_PATTERNS.some((rx) => rx.test(title));
}

export function assembleKoSupportingLiterature(phase2: Phase2Bundle): EvidenceItem[] {
    const pubmed = phase2.phase1.collectors.pubmedIndex;
    if (pubmed.coverage !== "available") return [];
    return pubmed.data.results
        .filter((r) => looksLikeKoLiterature(r.title))
        .slice(0, 10)
        .map<EvidenceItem>((r) => ({
            source: "pubmed",
            predicate: "ko_phenotype",
            pmid: r.pmid,
            excerpt: r.title,
            metadata: { year: r.year, journal: r.journal },
        }));
}

// ── Indications composite + filters ─────────────────────────────────

const MEASUREMENT_TERMS = /\b(level|levels|concentration|count|measurement|content|index|score)\s*$/i;

type PpiSource = "string" | "literature";

type PpiInputPartner = {
    proteinA: string;
    proteinB: string;
    score: number;
    experimentalScore?: number;
    databaseScore?: number;
    textminingScore?: number;
};

export function assembleMolecularInteractions(phase2: Phase2Bundle, fanout: FanoutResults | undefined) {
    const ppi = phase2.phase1.collectors.stringPpi;
    const polypharm = fanout?.perModulatorPolypharm.results ?? [];
    const rows: Array<{
        partner_id: string | null;
        partner_name: string;
        predicate: string;
        best_score: number;
        source_count: number;
        paper_count: number;
        evidence: EvidenceItem[];
    }> = [];

    if (ppi.coverage === "available") {
        const partners = dedupePpiPartners(ppi.data.partners);
        for (const p of partners.slice(0, 50)) {
            rows.push({
                partner_id: p.partner_id,
                partner_name: p.partner_name,
                predicate: "binding",
                best_score: p.combined_score,
                source_count: p.sources.length,
                paper_count: 0,
                evidence: [
                    {
                        source: "string",
                        predicate: "binding",
                        score: p.string_score ?? 0,
                        metadata: { combined_score: p.combined_score },
                    },
                ],
            });
        }
    }

    const byTarget = new Map<string, { name: string | null; pchembl: number; modulators: Set<string> }>();
    for (const item of polypharm) {
        if (item.coverage !== "available") continue;
        for (const hit of item.data.hits) {
            const cur = byTarget.get(hit.targetChemblId);
            const pch = hit.pchemblValue ?? 0;
            if (!cur || pch > cur.pchembl) {
                byTarget.set(hit.targetChemblId, {
                    name: hit.targetName ?? hit.targetChemblId,
                    pchembl: pch,
                    modulators: cur?.modulators ?? new Set(),
                });
            }
            byTarget.get(hit.targetChemblId)!.modulators.add(item.data.moleculeChemblId);
        }
    }
    for (const [id, v] of byTarget) {
        rows.push({
            partner_id: id,
            partner_name: v.name ?? id,
            predicate: "drug_binding",
            best_score: v.pchembl,
            source_count: 1,
            paper_count: 0,
            evidence: [...v.modulators].map<EvidenceItem>((m) => ({
                source: "chembl:polypharm",
                predicate: "drug_binding",
                score: v.pchembl,
                metadata: { partner_id: id, modulator: m },
            })),
        });
    }
    if (rows.length === 0) return null;
    return rows.slice(0, 100);
}

export function assembleBiomarkerPotential(phase2: Phase2Bundle) {
    const ot = phase2.phase1.collectors.opentargets;
    const clinvar = phase2.phase1.collectors.clinvar;
    const rows: Array<{
        partner_id: string | null;
        partner_name: string;
        predicate: string;
        best_score: number;
        source_count: number;
        paper_count: number;
        evidence: EvidenceItem[];
        metrics: Record<string, never>;
    }> = [];
    if (ot.coverage === "available") {
        for (const a of ot.data.associations) {
            if (a.knownDrugScore == null || a.knownDrugScore < 0.5) continue;
            rows.push({
                partner_id: a.diseaseId,
                partner_name: a.diseaseName,
                predicate: "predictive",
                best_score: a.knownDrugScore,
                source_count: 1,
                paper_count: 0,
                evidence: [
                    {
                        source: "opentargets:known_drug",
                        predicate: "predictive",
                        score: a.knownDrugScore,
                        metadata: { disease_id: a.diseaseId },
                    },
                ],
                metrics: {},
            });
        }
    }
    if (clinvar.coverage === "available") {
        const pathogenic = clinvar.data.variants.filter((v) => /pathogenic/i.test(v.clinicalSignificance));
        if (pathogenic.length > 0) {
            const conditions = new Map<string, number>();
            for (const v of pathogenic) {
                for (const c of v.conditions) {
                    if (!c) continue;
                    conditions.set(c, (conditions.get(c) ?? 0) + 1);
                }
            }
            for (const [condition, count] of conditions) {
                rows.push({
                    partner_id: null,
                    partner_name: condition,
                    predicate: "predictive",
                    best_score: Math.min(1, count / 10),
                    source_count: 1,
                    paper_count: 0,
                    evidence: [
                        {
                            source: "clinvar",
                            predicate: "predictive",
                            score: Math.min(1, count / 10),
                            metadata: { variant_count: count },
                        },
                    ],
                    metrics: {},
                });
            }
        }
    }
    rows.sort((a, b) => b.best_score - a.best_score);
    if (rows.length === 0) return null;
    return rows.slice(0, 50);
}

export function assembleResistanceEvidence(phase2: Phase2Bundle) {
    const pubmed = phase2.phase1.collectors.pubmedIndex;
    if (pubmed.coverage !== "available") return null;
    const RESISTANCE_RX = /\b(resistance|resistant|sensiti[sz]ation|sensiti[sz]er|tolerance|escape mutation)\b/i;
    const matches = pubmed.data.results.filter((r) => RESISTANCE_RX.test(r.title));
    if (matches.length === 0) return null;
    const rows = matches.slice(0, 50).map((r) => ({
        partner_id: null,
        partner_name: r.title.slice(0, 80),
        predicate: "resistance",
        best_score: 0.5,
        source_count: 1,
        paper_count: 1,
        evidence: [
            {
                source: "pubmed",
                predicate: "resistance",
                pmid: r.pmid,
                excerpt: r.title,
                metadata: { year: r.year, journal: r.journal },
            } satisfies EvidenceItem,
        ],
    }));
    return rows;
}

export function assembleCombinationEvidence(phase2: Phase2Bundle) {
    const pubmed = phase2.phase1.collectors.pubmedIndex;
    if (pubmed.coverage !== "available") return null;
    const COMBINATION_RX = /\b(combination|combinations|synergy|synergistic|synergi[sz]e|synergi[sz]ed|synergi[sz]es)\b/i;
    const matches = pubmed.data.results.filter((r) => COMBINATION_RX.test(r.title));
    if (matches.length === 0) return null;
    const rows = matches.slice(0, 50).map((r) => ({
        partner_id: null,
        partner_name: r.title.slice(0, 80),
        predicate: "combination_effect",
        best_score: 0.5,
        source_count: 1,
        paper_count: 1,
        evidence: [
            {
                source: "pubmed",
                predicate: "combination_effect",
                pmid: r.pmid,
                excerpt: r.title,
                metadata: { year: r.year, journal: r.journal },
            } satisfies EvidenceItem,
        ],
    }));
    return rows;
}

export function assembleEvidenceConflicts(phase2: Phase2Bundle) {
    const ot = phase2.phase1.collectors.opentargets;
    if (ot.coverage !== "available") return null;
    const rows: Array<{
        evidence_item_id: string;
        predicate: string;
        contradicting_predicates: string[];
        surfaced_in_section: string;
        evidence: EvidenceItem[];
    }> = [];
    for (const a of ot.data.associations) {
        const sources = [
            { name: "ot_genetics", v: a.geneticAssociationScore },
            { name: "ot_known_drug", v: a.knownDrugScore },
            { name: "ot_animal_model", v: a.animalModelScore },
            { name: "ot_somatic_mutation", v: a.somaticMutationScore },
            { name: "literature", v: a.literatureScore },
        ].filter((s): s is { name: string; v: number } => s.v != null);
        if (sources.length < 2) continue;
        const max = Math.max(...sources.map((s) => s.v));
        const min = Math.min(...sources.map((s) => s.v));
        if (max < 0.5 || min > 0.3) continue;
        const high = sources.find((s) => s.v === max)!.name;
        const low = sources.find((s) => s.v === min)!.name;
        rows.push({
            evidence_item_id: `ot:${a.diseaseId}`,
            predicate: `${high}=high`,
            contradicting_predicates: [`${low}=low`],
            surfaced_in_section: "indications",
            evidence: makeAssociationEvidence(a),
        });
    }
    if (rows.length === 0) return null;
    return rows.slice(0, 25);
}

export function assembleAdditionalEvidence(phase2: Phase2Bundle) {
    const ot = phase2.phase1.collectors.opentargets;
    if (ot.coverage !== "available" || ot.data.safetyLiabilities.length === 0) {
        return null;
    }
    const evidence: EvidenceItem[] = ot.data.safetyLiabilities.map((s) => ({
        source: `opentargets:safety:${s.source}`,
        predicate: "safety_liability",
        excerpt: `${s.event}${s.effects ? ` (${s.effects})` : ""}`,
        metadata: { biosamples: s.biosamples },
    }));
    return {
        rows: [
            {
                predicate: "safety_liability",
                evidence,
            },
        ],
        score_floor: 0.3,
    };
}

export function dedupePpiPartners(partners: PpiInputPartner[]) {
    const byId = new Map<
        string,
        {
            partner_id: string | null;
            partner_name: string;
            string_score: number | null;
            literature_score: number | null;
            sources: Set<PpiSource>;
        }
    >();
    const byNameKey = (s: string) => s.trim().toLowerCase();
    for (const p of partners) {
        const id = p.proteinB;
        const name = p.proteinB;
        if (byId.has(id)) {
            const cur = byId.get(id)!;
            cur.string_score = Math.max(cur.string_score ?? 0, p.score);
            cur.sources.add("string");
            continue;
        }
        byId.set(id, {
            partner_id: id,
            partner_name: name,
            string_score: p.score,
            literature_score: null,
            sources: new Set<PpiSource>(["string"]),
        });
    }
    const byName = new Map<string, ReturnType<typeof byId.get>>();
    for (const v of byId.values()) {
        const k = byNameKey(v!.partner_name);
        const existing = byName.get(k);
        if (existing) {
            existing!.string_score = Math.max(existing!.string_score ?? 0, v!.string_score ?? 0);
            for (const s of v!.sources) existing!.sources.add(s);
            continue;
        }
        byName.set(k, v);
    }
    return [...byName.values()].map((v) => ({
        partner_id: v!.partner_id,
        partner_name: v!.partner_name,
        string_score: v!.string_score,
        literature_score: v!.literature_score,
        combined_score: (v!.string_score ?? 0) + (v!.literature_score ?? 0),
        sources: [...v!.sources],
        has_human_evidence: true,
        has_clinical_evidence: false,
    }));
}

export function isClinicalMeasurement(name: string): boolean {
    return MEASUREMENT_TERMS.test(name.trim());
}

type FailureCategoryName = "safety" | "efficacy" | "strategic" | "operational";

const CATEGORY_PATTERNS: Array<{
    category: FailureCategoryName;
    rx: RegExp;
}> = [
    { category: "safety", rx: /(safety\s+signal|adverse\s+event|toxicity|hepato|cardio|fatal|death)[a-z\s]*?(\.|$)/i },
    { category: "efficacy", rx: /(lack\s+of\s+efficacy|did\s+not\s+meet\s+(?:primary|endpoint)|futility)[a-z\s]*?(\.|$)/i },
    { category: "strategic", rx: /(strategic|business|pipeline|portfolio|sponsor\s+decision|commercial)[a-z\s]*?(\.|$)/i },
    { category: "operational", rx: /(recruit|enroll|funding|covid|pandemic|site\s+closure|investigator|withdraw)[a-z\s]*?(\.|$)/i },
];

/**
 * Match the first known failure-cause pattern against `whyStopped` and return
 * the category plus the matched substring (truncated to 200 chars). When no
 * pattern matches, falls back to "operational" with the first 200 chars of
 * `whyStopped` itself — the v4 schema requires the evidence excerpt to be a
 * literal substring of `why_stopped`, which holds by construction.
 */
function classifyFailureCategory(whyStopped: string): {
    category: FailureCategoryName;
    evidenceExcerpt: string;
} {
    for (const { category, rx } of CATEGORY_PATTERNS) {
        const match = whyStopped.match(rx);
        if (match) {
            return { category, evidenceExcerpt: match[0].trim().slice(0, 200) };
        }
    }
    return {
        category: "operational",
        evidenceExcerpt: whyStopped.slice(0, 200),
    };
}

/**
 * Produce a v4 discriminated `failure_category` block. The "safety" branch
 * uses `safety_evidence_excerpt`; all other branches use
 * `category_evidence_excerpt`.
 */
export function buildFailureCategoryDiscriminated(
    whyStopped: string,
):
    | { category: "safety"; safety_evidence_excerpt: string }
    | { category: "efficacy"; category_evidence_excerpt: string }
    | { category: "strategic"; category_evidence_excerpt: string }
    | { category: "operational"; category_evidence_excerpt: string } {
    const { category, evidenceExcerpt } = classifyFailureCategory(whyStopped);
    if (category === "safety") {
        return { category, safety_evidence_excerpt: evidenceExcerpt };
    }
    return { category, category_evidence_excerpt: evidenceExcerpt };
}

export function isSelfReference(canonicalId: string, diseaseId: string, symbol: string, diseaseName: string): boolean {
    if (canonicalId && diseaseId && canonicalId === diseaseId) return true;
    if (symbol && diseaseName && diseaseName.trim().toUpperCase() === symbol.trim().toUpperCase()) {
        return true;
    }
    return false;
}

export const SOURCE_WEIGHTS: Record<string, number> = {
    literature: 0.05,
    ot_genetics: 0.2,
    ot_known_drug: 0.25,
    ot_animal_model: 0.1,
    ot_somatic_mutation: 0.1,
    clinvar: 0.15,
};

export function indicationCompositeScore(
    evidenceScore: number,
    sources: string[],
    paperCount: number,
): {
    composite: number;
    breakdown: {
        base: number;
        source_bonuses: Record<string, number>;
        paper_depth: number;
    };
} {
    const source_bonuses: Record<string, number> = {};
    let bonusSum = 0;
    for (const s of sources) {
        const w = SOURCE_WEIGHTS[s];
        if (w == null) continue;
        source_bonuses[s] = w;
        bonusSum += w;
    }
    const paper_depth = paperCount <= 0 ? 0 : Math.min(Math.log10(1 + paperCount) * 0.05, 0.15);
    const composite = evidenceScore + bonusSum + paper_depth;
    return {
        composite,
        breakdown: { base: evidenceScore, source_bonuses, paper_depth },
    };
}

// ── §3.10 helpers ────────────────────────────────────────────────────

const RANK_LEVEL: Record<string, number> = {
    absent: 0,
    low: 1,
    medium: 2,
    high: 3,
};

export function deterministicTranslationalCommentary(
    phase2: Phase2Bundle,
): Array<{ severity: "ok" | "caution" | "gap"; organ?: string; species?: string; text: string }> {
    const out: Array<{ severity: "ok" | "caution" | "gap"; organ?: string; species?: string; text: string }> = [];

    const impc = phase2.phase1.collectors.impc;
    if (impc.coverage === "available") {
        if (impc.data.viability === "lethal_pre_weaning") {
            out.push({
                severity: "caution",
                species: "mouse",
                text: "Mouse KO is pre-weaning lethal — therapeutic window depends on partial inhibition, conditional KO, or staged dosing.",
            });
        } else if (impc.data.viability === "subviable") {
            out.push({
                severity: "caution",
                species: "mouse",
                text: "Mouse KO is sub-viable — full inhibition tolerability uncertain; lead-finding should target partial occupancy or tissue-restricted exposure.",
            });
        }

        if (impc.data.sexDimorphic) {
            out.push({
                severity: "caution",
                species: "mouse",
                text: "Mouse KO phenotype is sex-dimorphic — preclinical PK/PD and safety studies must be sex-stratified to avoid masking effects.",
            });
        }

        if (impc.data.organSystems.length >= 3) {
            out.push({
                severity: "caution",
                organ: impc.data.organSystems.slice(0, 3).join(", "),
                species: "mouse",
                text: `Mouse KO produces phenotypes across ${impc.data.organSystems.length} organ systems — pleiotropy raises the bar for tissue-selective therapeutic windows.`,
            });
        }
    }

    const exp = phase2.phase1.collectors.expressionMultiSpecies;
    if (exp.coverage === "available") {
        const human = exp.data.bySpecies.find((s) => s.species === "homo_sapiens");
        if (human && human.tissues.length > 0) {
            for (const otherSpecies of exp.data.bySpecies) {
                if (otherSpecies.species === "homo_sapiens") continue;
                const speciesLabel = otherSpecies.species.replace("_", " ");
                for (const otherTissue of otherSpecies.tissues) {
                    if (!isSafetyRelevant(otherTissue.tissue)) continue;
                    const humanTissue = human.tissues.find((t) => t.tissue.toLowerCase() === otherTissue.tissue.toLowerCase());
                    if (!humanTissue) continue;
                    const hLevel = RANK_LEVEL[humanTissue.rank] ?? 0;
                    const oLevel = RANK_LEVEL[otherTissue.rank] ?? 0;
                    if (Math.abs(hLevel - oLevel) >= 2) {
                        out.push({
                            severity: "caution",
                            organ: otherTissue.tissue,
                            species: speciesLabel,
                            text: `Expression rank diverges by ≥2 steps between human (${humanTissue.rank}) and ${speciesLabel} (${otherTissue.rank}) in ${otherTissue.tissue} — translational extrapolation from this species is unreliable for safety in this organ.`,
                        });
                    }
                }
            }

            // Cross-species concordance: human + ≥2 non-human species converge at
            // `high` rank in the same safety-relevant tissue. This strengthens
            // translational confidence for that organ.
            for (const ht of human.tissues) {
                if (ht.rank !== "high" || !isSafetyRelevant(ht.tissue)) continue;
                const concordantSpecies: string[] = [];
                for (const other of exp.data.bySpecies) {
                    if (other.species === "homo_sapiens") continue;
                    const match = other.tissues.find((t) => t.tissue.toLowerCase() === ht.tissue.toLowerCase());
                    if (match && match.rank === "high") {
                        concordantSpecies.push(other.species.replace("_", " "));
                    }
                }
                if (concordantSpecies.length >= 2) {
                    out.push({
                        severity: "ok",
                        organ: ht.tissue,
                        text: `${ht.tissue} expresses at high rank in human and ${concordantSpecies.join(", ")} — preclinical safety findings in this tissue translate with higher confidence.`,
                    });
                }
            }
        }
        const queried = ["mus_musculus", "rattus_norvegicus", "macaca_mulatta", "canis_lupus_familiaris"];
        for (const sp of queried) {
            const tissues = exp.data.bySpecies.find((s) => s.species === sp)?.tissues ?? [];
            if (tissues.length === 0 && !exp.data.notFound.includes(sp)) {
                out.push({
                    severity: "gap",
                    species: sp.replace(/_/g, " "),
                    text: `${sp.replace(/_/g, " ")} expression queried but no tissue calls returned — cross-species coverage is incomplete.`,
                });
            }
        }
    }

    return out.slice(0, 6);
}

// ── Trial attribution ─────────────────────────────────────────────────

/**
 * Dependency-injected context for resolving drug-to-target mappings.
 * Allows tests to substitute a fake resolver without hitting ChEMBL APIs.
 */
export type AttributionContext = {
    assessmentUniprot: string;
    assessmentSymbol: string;
    familyUniprots: string[];
    drugTargetResolver: (chemblId: string) => Promise<string[]>;
};

/**
 * Map from UniProt accession to HGNC gene symbol for related-receptor labeling.
 * Extend as new receptor families gain assessment support.
 */
const UNIPROT_TO_SYMBOL: Record<string, string> = {
    P30988: "CALCR",
    P32241: "CALCRL",
};

/**
 * Partition a list of trials into primary (on-target or unresolved) and
 * related (off-target via a related family receptor). Each trial's
 * `match_confidence` is derived from ChEMBL mechanism resolution via
 * `classifyTrialAttribution`. When no `drugChemblId` is present on an
 * intervention (because the upstream ctgov bundle carries only drug names),
 * resolution is skipped and the trial lands in primary with confidence "low".
 */
export async function partitionTrialsByAttribution<
    T extends {
        nctId: string;
        title: string;
        interventions?: string[] | Array<{ drugChemblId: string | null; name: string }>;
        conditions?: string[];
    },
>(
    trials: T[],
    ctx: AttributionContext,
): Promise<{
    primary: Array<T & { match_confidence: "high" | "medium" | "low" }>;
    related: Array<T & { match_confidence: "off_target" }>;
    related_receptor: string | undefined;
}> {
    const primary: Array<T & { match_confidence: "high" | "medium" | "low" }> = [];
    const related: Array<T & { match_confidence: "off_target" }> = [];
    const relatedAccs = new Set<string>();

    for (const trial of trials) {
        // Normalize interventions: ctgov bundle has string[], typed input may use objects.
        const interventions: Array<{ drugChemblId: string | null; name: string }> = Array.isArray(trial.interventions)
            ? trial.interventions.map((iv) => (typeof iv === "string" ? { drugChemblId: null, name: iv } : iv))
            : [];

        const result = await classifyTrialAttribution({
            assessmentUniprot: ctx.assessmentUniprot,
            familyUniprots: ctx.familyUniprots,
            interventions,
            conditions: trial.conditions ?? [],
            drugTargetResolver: ctx.drugTargetResolver,
        });

        if (result.match_confidence === "off_target") {
            related.push({ ...trial, match_confidence: "off_target" as const });
            for (const a of result.related_target_uniprots) relatedAccs.add(a);
        } else {
            primary.push({ ...trial, match_confidence: result.match_confidence });
        }
    }

    const related_receptor =
        relatedAccs.size > 0
            ? [...relatedAccs]
                  .map((a) => UNIPROT_TO_SYMBOL[a] ?? a)
                  .sort()
                  .join("/")
            : undefined;

    return { primary, related, related_receptor };
}

// ── §4.x analytics — discovery trials, evidence timeline, translational chain ──

type RelevanceBasis =
    | { kind: "drug_in_class_match"; drug_id: string; matched_term: string }
    | { kind: "title_keyword"; matched_term: string }
    | { kind: "condition_match"; matched_term?: string };

/**
 * Classify why a candidate trial is considered relevant to the assessment.
 * Checks interventions against known class drug names first (strongest signal),
 * then falls back to title keyword matching, then condition match (weakest).
 *
 * Rows with match_confidence="low" and kind="condition_match" are unreliable
 * (they may be in the same broad disease area but use a completely different
 * drug class — e.g., SGLT2 inhibitors appearing in a GLP-1R dossier).
 * These rows are dropped by the caller before they reach the dossier.
 */
export function classifyRelevanceBasis(
    trial: {
        interventions?: string[];
        conditions?: string[];
        title: string;
    },
    knownClassDrugNames: Set<string>,
    titleKeywordRx: RegExp,
): RelevanceBasis {
    // Check interventions against known class drugs (case-insensitive).
    for (const iv of trial.interventions ?? []) {
        const ivU = iv.toUpperCase();
        for (const drug of knownClassDrugNames) {
            if (ivU.includes(drug)) {
                return { kind: "drug_in_class_match", drug_id: drug, matched_term: iv };
            }
        }
    }

    // Check title for target-specific keywords.
    const titleMatch = titleKeywordRx.exec(trial.title);
    if (titleMatch) {
        return { kind: "title_keyword", matched_term: titleMatch[0] };
    }

    // Fall back to condition match.
    return { kind: "condition_match", matched_term: trial.conditions?.[0] };
}

/**
 * Classify match confidence for a clinical trial row in the
 * `clinical_development.trials` section.
 *
 * Priority order:
 * 1. "high"   — gene symbol appears in intervention name or trial title.
 * 2. "medium" — intervention name matches a known class drug (drug-in-class).
 * 3. "medium" — gene symbol appears in a condition string.
 * 4. "low"    — no match on any signal.
 *
 * Drug-in-class matching uses case-insensitive substring comparison against
 * `knownClassDrugNames` (uppercase strings from ChEMBL modulators). This
 * promotes calcitonin-class interventions (e.g. "Calcitonin-salmon", "SMC021")
 * for a CALCR assessment even when the gene symbol itself is absent from the
 * intervention name.
 */
export function classifyClinicalTrialConfidence(
    trial: {
        interventions?: string[];
        conditions?: string[];
        title: string;
    },
    geneSymbol: string,
    knownClassDrugNames: Set<string>,
): "high" | "medium" | "low" {
    const symU = geneSymbol.toUpperCase();
    const inInterventions = (trial.interventions ?? []).some((i) => i.toUpperCase().includes(symU));
    const inTitle = trial.title.toUpperCase().includes(symU);
    if (inInterventions || inTitle) return "high";

    // Drug-in-class: check each intervention name against known class drug names.
    // Normalize hyphens to spaces before comparison so "Calcitonin-salmon" matches
    // the ChEMBL preferred name "CALCITONIN SALMON".
    for (const iv of trial.interventions ?? []) {
        const ivU = iv.toUpperCase().replace(/-/g, " ");
        for (const drug of knownClassDrugNames) {
            if (ivU.includes(drug)) return "medium";
        }
    }

    const inConditions = (trial.conditions ?? []).some((c) => c.toUpperCase().includes(symU));
    if (inConditions) return "medium";

    return "low";
}

export async function assembleDiscoveryTrials(phase2: Phase2Bundle, symbol: string, attrCtx: AttributionContext, knownClassDrugNames: Set<string>) {
    const ctgov = phase2.phase1.collectors.ctgov;
    if (ctgov.coverage !== "available") return null;
    const symU = symbol.toUpperCase();

    // Build a case-insensitive title-keyword regex from the target symbol and
    // common synonyms embedded in the assessment symbol name. For most targets
    // the symbol itself (e.g. "GLP1R", "CALCR") is the right anchor; the regex
    // allows optional separators so "GLP-1R" and "GLP 1R" also match.
    const escapedSym = symbol.replace(/[-]/g, "[-\\s]?").replace(/\d+/, "\\d+");
    const titleKeywordRx = new RegExp(`\\b${escapedSym}\\b`, "i");

    // Exclude trials already covered by §2.5a (high-confidence by name/title match).
    const candidates = ctgov.data.active.filter((t) => {
        const inInterventions = t.interventions.some((i) => i.toUpperCase().includes(symU));
        const inTitle = t.title.toUpperCase().includes(symU);
        return !(inInterventions || inTitle);
    });

    if (candidates.length === 0) return null;

    const partitioned = await partitionTrialsByAttribution(candidates, attrCtx);

    // Classify each primary candidate's relevance basis and drop low-confidence
    // condition-only matches — these are wrong-class contaminants (e.g., an
    // SGLT2 trial picked up because it studies T2D while assessing GLP1R).
    const primaryRows = partitioned.primary
        .map((t) => {
            const relevance_basis = classifyRelevanceBasis(t, knownClassDrugNames, titleKeywordRx);
            return {
                nct_id: t.nctId,
                title: t.title,
                phase: t.phase,
                status: t.status,
                conditions: t.conditions,
                // Convert null → undefined to match DiscoveryTrialRowV4Schema optional fields.
                start_date: t.startDate ?? undefined,
                completion_date: t.primaryCompletionDate ?? undefined,
                match_confidence: t.match_confidence,
                relevance_basis,
            };
        })
        .filter((row) => {
            // Drop low-confidence rows whose only basis is a generic condition string.
            // These fail the DiscoveryTrialRowV4Schema superRefine invariant and must
            // not reach the dossier.
            return !(row.match_confidence === "low" && row.relevance_basis.kind === "condition_match");
        });

    const relatedRows = partitioned.related.map((t) => ({
        nct_id: t.nctId,
        title: t.title,
        phase: t.phase,
        status: t.status,
        conditions: t.conditions,
        start_date: t.startDate,
        completion_date: t.primaryCompletionDate,
        match_confidence: t.match_confidence as "off_target",
    }));

    if (primaryRows.length === 0 && relatedRows.length === 0) return null;

    return {
        rows: primaryRows.slice(0, 100),
        ...(relatedRows.length > 0
            ? {
                  related_target_trials: relatedRows,
                  related_receptor: partitioned.related_receptor,
              }
            : {}),
    };
}

export function assembleEvidenceTimeline(phase2: Phase2Bundle) {
    const pubmed = phase2.phase1.collectors.pubmedIndex;
    if (pubmed.coverage !== "available" || pubmed.data.results.length === 0) {
        return null;
    }
    const histogram: Record<string, number> = {};
    let first: number | null = null;
    let last: number | null = null;
    for (const r of pubmed.data.results) {
        const y = parseInt(r.year, 10);
        if (!Number.isFinite(y)) continue;
        histogram[String(y)] = (histogram[String(y)] ?? 0) + 1;
        if (first == null || y < first) first = y;
        if (last == null || y > last) last = y;
    }
    const trend_labels: string[] = [];
    if (first != null && last != null) {
        const recent = Object.entries(histogram)
            .filter(([y]) => parseInt(y, 10) >= last - 4)
            .reduce((s, [, n]) => s + n, 0);
        const earlier = Object.entries(histogram)
            .filter(([y]) => parseInt(y, 10) >= last - 9 && parseInt(y, 10) < last - 4)
            .reduce((s, [, n]) => s + n, 0);
        if (recent > earlier * 1.5) trend_labels.push("accelerating");
        else if (recent < earlier * 0.66) trend_labels.push("decelerating");
        else trend_labels.push("steady");
    }
    return {
        histogram,
        first_reported_year: first,
        last_reported_year: last,
        trend_labels,
    };
}

const TIER_ORDER = ["computational", "basic_in_vitro", "complex_in_vitro", "in_vivo_animal", "ex_vivo_human", "clinical"] as const;
type Tier = (typeof TIER_ORDER)[number];

export function computeTranslationalChainSummary(tiers: Array<{ tier: Tier; claim_count: number; paper_count: number }>): {
    peak_evidence_tier: Tier | null;
    progression_complete: boolean;
    weakest_progression_gap: Tier | null;
} {
    const peakEntry = tiers.reduce<(typeof tiers)[number] | null>(
        (best, current) => (best === null || current.claim_count > best.claim_count ? current : best),
        null,
    );
    const peak_evidence_tier = peakEntry && peakEntry.claim_count > 0 ? peakEntry.tier : null;

    const clinicalRow = tiers.find((t) => t.tier === "clinical");
    const progression_complete = (clinicalRow?.claim_count ?? 0) >= 1;

    // First present-tier whose immediate successor in TIER_ORDER has zero claims.
    const presentByTier = new Map(tiers.map((t) => [t.tier, t.claim_count > 0] as const));
    let weakest_progression_gap: Tier | null = null;
    for (let i = 0; i < TIER_ORDER.length - 1; i++) {
        const here = TIER_ORDER[i]!;
        const next = TIER_ORDER[i + 1]!;
        if (presentByTier.get(here) && !presentByTier.get(next)) {
            weakest_progression_gap = here;
            break;
        }
    }

    return { peak_evidence_tier, progression_complete, weakest_progression_gap };
}

export function assembleTranslationalChain(phase2: Phase2Bundle) {
    const pubmed = phase2.phase1.collectors.pubmedIndex;
    const ctgov = phase2.phase1.collectors.ctgov;
    const impc = phase2.phase1.collectors.impc;
    const exp = phase2.phase1.collectors.expressionMultiSpecies;
    if (pubmed.coverage !== "available" && ctgov.coverage !== "available" && impc.coverage !== "available") {
        return null;
    }
    const tierCounts: Record<Tier, { claims: number; pmids: Set<string> }> = {
        computational: { claims: 0, pmids: new Set() },
        basic_in_vitro: { claims: 0, pmids: new Set() },
        complex_in_vitro: { claims: 0, pmids: new Set() },
        in_vivo_animal: { claims: 0, pmids: new Set() },
        ex_vivo_human: { claims: 0, pmids: new Set() },
        clinical: { claims: 0, pmids: new Set() },
    };
    if (impc.coverage === "available" && impc.data.phenotypeCount > 0) {
        tierCounts.in_vivo_animal.claims += impc.data.phenotypeCount;
    }
    if (exp.coverage === "available") {
        for (const s of exp.data.bySpecies) {
            if (s.species !== "homo_sapiens") tierCounts.in_vivo_animal.claims += s.tissues.length;
        }
    }
    if (pubmed.coverage === "available") {
        for (const r of pubmed.data.results) {
            const inf = inferSpeciesFromTitle(r.title);
            const tier: Tier = inf
                ? inf.modelSystem === "ex_vivo_human"
                    ? "ex_vivo_human"
                    : inf.modelSystem === "complex_in_vitro"
                      ? "complex_in_vitro"
                      : "in_vivo_animal"
                : "basic_in_vitro";
            tierCounts[tier].claims += 1;
            tierCounts[tier].pmids.add(r.pmid);
        }
    }
    if (ctgov.coverage === "available") {
        tierCounts.clinical.claims += ctgov.data.active.length + ctgov.data.failed.length;
    }
    const tierRows = TIER_ORDER.map((tier) => ({
        tier,
        claim_count: tierCounts[tier].claims,
        paper_count: tierCounts[tier].pmids.size,
    }));
    const summary = computeTranslationalChainSummary(tierRows);
    return {
        tiers: tierRows,
        peak_evidence_tier: summary.peak_evidence_tier,
        progression_complete: summary.progression_complete,
        weakest_progression_gap: summary.weakest_progression_gap,
    };
}
