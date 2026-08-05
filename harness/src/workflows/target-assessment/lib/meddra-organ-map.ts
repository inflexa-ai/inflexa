/**
 * MedDRA terms and CT.gov system-organ classes onto the canonical organ
 * vocabulary.
 *
 * The values are the canonical tokens, so this module declares no organ
 * enumeration of its own. Every token in the vocabulary is reachable through
 * the rules below, so nothing a producer may legitimately attribute is
 * unreachable by accident.
 *
 * A term resolves onto the organ it names, or onto nothing. A term whose
 * compartment is genuinely ambiguous — "Paraesthesia" and the other nervous
 * system terms that name no compartment, "Adrenal insufficiency" and the other
 * endocrine terms outside the thyroid — matches no rule, so the caller drops
 * and counts it rather than filing it under a neighbour.
 */

import { ORGAN_SYSTEMS, type OrganSystem } from "../../../contracts/organ-system.js";

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
const RULES: Array<{ rx: RegExp; organ: OrganSystem }> = [
    // pancreas (specific) — must come before generic GI
    { rx: /\bpancreatit|\bamylase|\blipase/i, organ: "pancreas" },
    // thyroid / C-cell. The token names the thyroid, not the endocrine system,
    // so a non-thyroid endocrine term deliberately matches nothing here.
    { rx: /thyroid|\b(c[-\s]?cell|calcitonin|goit[re]+|medullar[a-z]*\s*carcinoma)/i, organ: "endocrine_thyroid" },
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
    // vascular — placed after cardiac so a myocardial event stays cardiac.
    // `thrombos` rather than the `thrombo` stem, which would swallow
    // THROMBOCYTOPENIA; `\bvascul` never matches inside CEREBROVASCULAR.
    { rx: /\b(hypertens|hypotens|vasculit|vascular|thrombos|thromboemboli|thrombophleb|embolism|aneurysm|varicose|phlebit)/i, organ: "vascular" },
    // metabolic (glucose, weight, lipid)
    // triglyc has no leading \b because it appears mid-word in HYPERTRIGLYCERIDAEMIA
    { rx: /\b(glucose|glycaemi|hba1c|insulin|weight\s+(?:decreased|increased)|lipid|cholester|dehydration)|triglyc/i, organ: "metabolic" },
    // respiratory — above the neurological rules so RESPIRATORY DEPRESSION is
    // read as a respiratory event rather than by the bare "depression" stem
    { rx: /\b(nasopharyng|pharyng|bronch|pneumon|dyspnoe|dyspnea|cough|respiratory|sinusit|pulmonary)/i, organ: "respiratory" },
    // hematologic — above the neurological rules for the same reason, so
    // BONE MARROW DEPRESSION is read as haematologic
    { rx: /\b(haemoglobin|hemoglobin|haematocrit|leuko|neutro|thrombocyt|anaemi|haemat|platelet|marrow)/i, organ: "hematologic" },
    // ocular — above the nerve rules so OPTIC NEUROPATHY stays ocular.
    // `macular` is pinned to its ocular compounds so it never matches
    // MACULOPAPULAR RASH.
    {
        rx: /\b(ocular|ophthalm|retinopath|retinal|glaucoma|cataract|uveit|conjunctivit|blindness|vision|visual|keratit|scleriti|blephariti|eye\s|macular\s+(?:oedema|edema|degenerat)|optic\s+(?:neuropath|neurit|atroph))/i,
        organ: "ocular",
    },
    // peripheral nervous system — a neuropathy is a disease of the peripheral
    // nerves; a central lesion is named by the terms in the cns rule below
    // `neuropath` carries no leading \b so POLYNEUROPATHY and MONONEUROPATHY
    // resolve as well as NEUROPATHY PERIPHERAL
    { rx: /neuropath|neurit|\b(radiculopath|neuralg|carpal\s+tunnel|guillain|plexopath|peripheral\s+(?:motor|sensory))/i, organ: "pns" },
    // central nervous system
    {
        rx: /\b(headache|dizz|seizure|convuls|suici|depression|anxiet|encephalo|migrain|myelopath|meningit|cerebr|intracranial|somnolen|ataxi|tremor|stroke)/i,
        organ: "cns",
    },
    // dermatologic
    { rx: /\b(rash|eczem|prurit|urticari|injection\s+site\s+(?:pain|haemorrhag|erythem))/i, organ: "dermatologic" },
    // musculoskeletal — malignant hyperthermia is a skeletal-muscle crisis and
    // is matched here so the malignancy stem below never claims it
    { rx: /\b(arthralg|myalg|musculoskel|fracture|bone\s+pain|rhabdomyol|malignant\s+hyperthermi)/i, organ: "musculoskeletal" },
    // immune
    { rx: /\b(hypersensitiv|anaphyl|autoimmune|cytokine\s+release)/i, organ: "immune" },
    // reproductive
    { rx: /\b(menstrual|menorrhag|ovari|endometr|prostat|erectile)/i, organ: "reproductive" },
    // oncology — last, so a malignancy that names its site is filed under that
    // site and only a term whose content is the malignancy itself lands here
    { rx: /\b(neoplasm|malignan|carcinoma|sarcoma|lymphoma|leukaemi|leukemi|myeloma|myelodysplas|melanoma|metastas|tumour|tumor|cancer)/i, organ: "oncology" },
];

const UNINFORMATIVE_RE =
    /\b(incorrect\s+dose|off\s+label|drug\s+ineffective|product\s+(?:use|storage|administration)|accidental\s+exposure|inappropriate\s+schedule|exposure\s+via\s+skin|extra\s+dose|wrong\s+technique)\b/i;

export function classifyOrgan(meddraTerm: string): OrganSystem | null {
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
 *
 * A SOC that spans more than one canonical organ is absent: "Nervous system
 * disorders" covers both nervous-system tokens and "Endocrine disorders" is
 * broader than the thyroid, so a row under either resolves by its preferred
 * term or not at all.
 */
export const TRIAL_AE_ORGAN_MAP: Record<string, OrganSystem> = {
    "Gastrointestinal disorders": "gi",
    "Cardiac disorders": "cardiac",
    "Vascular disorders": "vascular",
    "Hepatobiliary disorders": "hepatic",
    "Renal and urinary disorders": "renal",
    "Respiratory, thoracic and mediastinal disorders": "respiratory",
    "Skin and subcutaneous tissue disorders": "dermatologic",
    "Musculoskeletal and connective tissue disorders": "musculoskeletal",
    "Metabolism and nutrition disorders": "metabolic",
    "Blood and lymphatic system disorders": "hematologic",
    "Reproductive system and breast disorders": "reproductive",
    "Immune system disorders": "immune",
    "Eye disorders": "ocular",
    "Neoplasms benign, malignant and unspecified (incl cysts and polyps)": "oncology",
};

/**
 * Classify a trial AE row by its SOC (preferred) or its individual MedDRA
 * preferred term (fallback). Shared between the Phase-4 assembler's
 * organ_rollup builder and the derived-completeness validator so both
 * agree on which organ a trial AE belongs to.
 */
export function classifyTrialAe(ae: { term?: string | null; organ?: string | null }): OrganSystem | null {
    const fromSoc = TRIAL_AE_ORGAN_MAP[ae.organ ?? ""];
    if (fromSoc) return fromSoc;
    return classifyOrgan(ae.term ?? "");
}

const ORGAN_SYSTEM_NAMES = new Set<string>(ORGAN_SYSTEMS);

/**
 * Classify a polypharm off-target panel row by its `organ_system` string, which
 * the curated safety panel already keys to the canonical vocabulary.
 *
 * Falls back to `classifyOrgan` if the upstream string is non-canonical;
 * this preserves coverage if a future collector emits MedDRA terms instead
 * of canonical organ names.
 */
export function classifyPolypharmOrgan(organSystem: string | null | undefined): OrganSystem | null {
    const sys = (organSystem ?? "").toLowerCase().trim();
    if (!sys) return null;
    // Canonical names from the safety panel enum match by direct string equality.
    if (ORGAN_SYSTEM_NAMES.has(sys)) return sys as OrganSystem;
    return classifyOrgan(sys);
}
