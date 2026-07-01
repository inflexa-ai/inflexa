/**
 * Tox-voice canon. Lists are intentionally not exhaustive — they are the
 * minimum surface the deterministic voice probe enforces. Editorial
 * judgment in the agent prompts covers the long tail.
 */

export const toxVoiceVocabulary = {
    organSystems: [
        "hepatobiliary",
        "renal",
        "cardiac",
        "vascular",
        "haematologic",
        "central nervous system",
        "peripheral nervous system",
        "respiratory",
        "gastrointestinal",
        "reproductive",
        "endocrine",
        "musculoskeletal",
        "dermatologic",
        "ocular",
        "immunologic",
    ] as const,

    liabilityFraming: [
        "on-target liability",
        "off-target liability",
        "secondary pharmacology",
        "class liability",
        "mechanism-related",
        "exaggerated pharmacology",
        "target-organ toxicity",
    ] as const,

    hedgePhrases: [
        "the data are consistent with",
        "the data suggest",
        "human relevance is uncertain",
        "human relevance remains to be established",
        "interpretation is limited by",
        "no causal inference is supported",
        "the available evidence is consistent with",
        "the available evidence does not support",
        "translatability to humans is unclear",
        "species differences",
    ] as const,

    banned: [
        // Marketing register
        "groundbreaking",
        "cutting-edge",
        "state-of-the-art",
        "best-in-class",
        "first-in-class",
        "revolutionary",
        "leverages",
        "leveraging",
        "robust",
        "powerful",
        "seamlessly",
        "cleanly",
        "elegant",
        "unparalleled",

        // Hype verbs
        "demonstrates the power of",
        "showcases",
        "unlocks",
        "enables breakthrough",

        // Vague absolutes
        "very promising",
        "extremely",
        "incredibly",
        "highly innovative",
    ] as const,
} as const;

export type OrganSystem = (typeof toxVoiceVocabulary.organSystems)[number];
export type LiabilityFraming = (typeof toxVoiceVocabulary.liabilityFraming)[number];
export type HedgePhrase = (typeof toxVoiceVocabulary.hedgePhrases)[number];
export type BannedTerm = (typeof toxVoiceVocabulary.banned)[number];
