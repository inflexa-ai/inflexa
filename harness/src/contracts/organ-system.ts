/**
 * The canonical organ-system vocabulary.
 *
 * This is the ONLY organ vocabulary in the package. Per-organ evidence is
 * joined by equality on these tokens, so a second enumeration — even a
 * "temporary" or deprecated one — reintroduces the string matching this
 * exists to remove. Producers resolve external and model-supplied organ
 * names onto these tokens at their own boundary.
 *
 * Membership is anatomical, with one deliberate exception: `oncology` is a
 * therapeutic area rather than an organ system, so grouping by it does not
 * denote a site. It is retained because malignancy signals — MedDRA neoplasm
 * SOC terms, and regulatory findings matched on malignancy keywords — have
 * no other channel to arrive on, and dropping the member would discard them.
 * Known debt: the honest fix is a separate non-organ signal channel.
 */

import { z } from "zod";

export const ORGAN_SYSTEMS = [
    "cardiac",
    "vascular",
    "hepatic",
    "renal",
    "cns",
    "pns",
    "gi",
    "pancreas",
    "endocrine_thyroid",
    "metabolic",
    "hematologic",
    "immune",
    "respiratory",
    "reproductive",
    "musculoskeletal",
    "dermatologic",
    "ocular",
    "oncology",
] as const;

export const OrganSystemSchema = z.enum(ORGAN_SYSTEMS);
export type OrganSystem = (typeof ORGAN_SYSTEMS)[number];

/**
 * Reader-facing prose for each canonical token.
 *
 * Narrative surfaces (agent voice, rendered dossiers) read these; structured
 * fields always carry the token. Keeping the prose a projection of the token
 * — rather than its own list — is what stops the two drifting into the
 * separate vocabularies this module replaces.
 */
export const ORGAN_SYSTEM_LABELS: Record<OrganSystem, string> = {
    cardiac: "cardiac",
    vascular: "vascular",
    hepatic: "hepatobiliary",
    renal: "renal",
    cns: "central nervous system",
    pns: "peripheral nervous system",
    gi: "gastrointestinal",
    pancreas: "pancreatic",
    endocrine_thyroid: "endocrine (thyroid)",
    metabolic: "metabolic",
    hematologic: "haematologic",
    immune: "immunologic",
    respiratory: "respiratory",
    reproductive: "reproductive",
    musculoskeletal: "musculoskeletal",
    dermatologic: "dermatologic",
    ocular: "ocular",
    oncology: "oncology",
};

export const organSystemLabel = (organ: OrganSystem): string => ORGAN_SYSTEM_LABELS[organ];
