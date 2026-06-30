export type CanonicalOrgan =
    | "cardiac"
    | "hepatic"
    | "cns"
    | "renal"
    | "gi"
    | "pancreas"
    | "endocrine_thyroid"
    | "metabolic"
    | "hematologic"
    | "immune"
    | "respiratory"
    | "reproductive"
    | "dermatologic"
    | "musculoskeletal"
    | "oncology";

/**
 * Order matters: more-specific patterns first. GI is matched before
 * "metabolic" because terms like "blood glucose" should land in
 * metabolic, but "nausea" / "vomiting" must not be reclassified by
 * later metabolic glucose rules.
 *
 * Patterns are stem-based (e.g. "nause" matches "NAUSEA"), so trailing
 * \b is omitted — the stem does not end at a word boundary inside the
 * full MedDRA term. A leading \b is kept to prevent mid-word false matches.
 */
const RULES: Array<{ rx: RegExp; organ: CanonicalOrgan }> = [
    // pancreas (specific) — must come before generic GI
    { rx: /\bpancreatit|\bamylase|\blipase/i, organ: "pancreas" },
    // thyroid / C-cell
    { rx: /\b(thyroid|c[-\s]?cell|calcitonin|goit[re]+|medullar[a-z]*\s*(?:thyroid|carcinoma))/i, organ: "endocrine_thyroid" },
    // gastrointestinal
    { rx: /\b(nause|vomit|diarrhoe|diarrhea|constipat|ileus|gastropares|abdominal\s*pain|cholecystit|cholelithias|gallbladder|colit|heartburn)/i, organ: "gi" },
    // hepatic — liver/alt/ast forms added; alt/ast pinned to "increased" to avoid
    // over-firing on terms like "ALTERED MENTAL STATUS"
    {
        rx: /\b(hepatit|hepato|jaundic|cholestas|transaminas|bilirubin|liver|alt\s+increased|ast\s+increased|alanine\s+aminotransferase|aspartate\s+aminotransferase)/i,
        organ: "hepatic",
    },
    // renal — haematur/hematur explicitly placed here (above hematologic) to prevent
    // the broad \bhaemat stem from misclassifying HAEMATURIA as hematologic
    { rx: /\b(renal|kidney|nephro|creatinin|glomerul|dialys|haematur|hematur)/i, organ: "renal" },
    // cardiac — cardi(ac|al|o) covers CARDIOMYOPATHY/CARDIOVASCULAR/CARDIOTOXICITY;
    // bare heart covers HEART FAILURE, HEART RATE INCREASED, etc.
    { rx: /\b(cardi(?:ac|al|o)|heart|myocard|tachycard|brady\w*card|arrhythm|atrial\s+fibrillat|qt\s+prolong|torsade)/i, organ: "cardiac" },
    // metabolic (glucose, weight, lipid)
    // triglyc has no leading \b because it appears mid-word in HYPERTRIGLYCERIDAEMIA
    { rx: /\b(glucose|glycaemi|hba1c|insulin|weight\s+(?:decreased|increased)|lipid|cholester|dehydration)|triglyc/i, organ: "metabolic" },
    // cns
    { rx: /\b(headache|dizz|seizure|suici|depression|anxiet|paraesthes|neuropath|encephalo|migrain)/i, organ: "cns" },
    // hematologic
    { rx: /\b(haemoglobin|hemoglobin|haematocrit|leuko|neutro|thrombocyt|anaemi|haemat|platelet)/i, organ: "hematologic" },
    // respiratory
    { rx: /\b(nasopharyng|pharyng|bronch|pneumon|dyspnoe|dyspnea|cough|respiratory|sinusit)/i, organ: "respiratory" },
    // dermatologic
    { rx: /\b(rash|eczem|prurit|urticari|injection\s+site\s+(?:pain|haemorrhag|erythem))/i, organ: "dermatologic" },
    // musculoskeletal
    { rx: /\b(arthralg|myalg|musculoskel|fracture|bone\s+pain)/i, organ: "musculoskeletal" },
    // immune
    { rx: /\b(hypersensitiv|anaphyl|autoimmune|cytokine\s+release)/i, organ: "immune" },
    // reproductive
    { rx: /\b(menstrual|menorrhag|ovari|endometr|prostat|erectile)/i, organ: "reproductive" },
];

const UNINFORMATIVE_RE =
    /\b(incorrect\s+dose|off\s+label|drug\s+ineffective|product\s+(?:use|storage|administration)|accidental\s+exposure|inappropriate\s+schedule|exposure\s+via\s+skin|extra\s+dose|wrong\s+technique)\b/i;

export function classifyOrgan(meddraTerm: string): CanonicalOrgan | null {
    if (UNINFORMATIVE_RE.test(meddraTerm)) return null;
    for (const { rx, organ } of RULES) {
        if (rx.test(meddraTerm)) return organ;
    }
    return null;
}

/**
 * MedDRA SOC (System Organ Class) names as they appear in CT.gov structured
 * AE tables → canonical organ. SOC strings (e.g. "Gastrointestinal disorders")
 * do not contain MedDRA PT stems, so `classifyOrgan` returns null for them —
 * the SOC map is the primary path; `classifyOrgan(term)` is the fallback when
 * the SOC string isn't in the map.
 */
export const TRIAL_AE_ORGAN_MAP: Record<string, CanonicalOrgan> = {
    "Gastrointestinal disorders": "gi",
    "Cardiac disorders": "cardiac",
    "Nervous system disorders": "cns",
    "Hepatobiliary disorders": "hepatic",
    "Renal and urinary disorders": "renal",
    "Endocrine disorders": "endocrine_thyroid",
    "Respiratory, thoracic and mediastinal disorders": "respiratory",
    "Skin and subcutaneous tissue disorders": "dermatologic",
    "Musculoskeletal and connective tissue disorders": "musculoskeletal",
    "Metabolism and nutrition disorders": "metabolic",
    "Blood and lymphatic system disorders": "hematologic",
    "Reproductive system and breast disorders": "reproductive",
    "Immune system disorders": "immune",
};

/**
 * Classify a trial AE row by its SOC (preferred) or its individual MedDRA
 * preferred term (fallback). Shared between the Phase-4 assembler's
 * organ_rollup builder and the derived-completeness validator so both
 * agree on which organ a trial AE belongs to.
 */
export function classifyTrialAe(ae: { term?: string | null; organ?: string | null }): CanonicalOrgan | null {
    const fromSoc = TRIAL_AE_ORGAN_MAP[ae.organ ?? ""];
    if (fromSoc) return fromSoc;
    return classifyOrgan(ae.term ?? "");
}

/**
 * Classify a polypharm off-target panel row by its canonical `organ_system`
 * string (set by the curated safety panel — `cardiac` | `hepatic` | `cns` |
 * `renal` | `gi` | `hematologic` | `immune` | `metabolic` | `respiratory`).
 *
 * Falls back to `classifyOrgan` if the upstream string is non-canonical;
 * this preserves coverage if a future collector emits MedDRA terms instead
 * of canonical organ names.
 */
export function classifyPolypharmOrgan(organSystem: string | null | undefined): CanonicalOrgan | null {
    const sys = (organSystem ?? "").toLowerCase().trim();
    if (!sys) return null;
    // Canonical names from the safety panel enum match by direct string equality.
    if (CANONICAL_ORGAN_NAMES.has(sys)) return sys as CanonicalOrgan;
    return classifyOrgan(sys);
}

const CANONICAL_ORGAN_NAMES = new Set<string>([
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
    "oncology",
]);
