import { toxVoiceVocabulary } from "./vocabulary.js";
import type { SectionType } from "./exemplars.js";

export interface VoiceProbe {
    verdict: "pass" | "relaxed" | "fail-voice";
    critique: string;
    output_chars: number;
}

const COLLOQUIAL_ORGAN_SUBS: ReadonlyArray<readonly [RegExp, string]> = [
    [/\bliver[- ]related\b/i, "hepatobiliary"],
    [/\bblood[- ]issues?\b/i, "haematologic"],
    [/\bbrain[- ]effects?\b/i, "central nervous system"],
    [/\bkidney[- ]problems?\b/i, "renal"],
    [/\bheart[- ]issues?\b/i, "cardiac"],
];

const EFFICACY_SAFETY_TRIGGERS = [
    /\b(reduces?|increases?|prolongs?|prevents?|inhibits?)\b/i,
    /\b(toxicity|liability|adverse|signal)\b/i,
    /\b(efficacy|response|survival|tumour|tumor)\b/i,
];

const CITATION_PATTERNS = [
    /PMID[:\s]?\d+/i,
    /DOI[:\s]?10\.[\d.]+\/\S+/i,
    /Drugs@FDA\s+(NDA|BLA)\s*\d+/i,
    /\bICH\s+[A-Z]\d+[A-Z]?\b/,
    /FDA\s+(CDER|CBER)\s+guidance/i,
    /FAERS\s+n\s*=\s*\d+/i,
];

/**
 * Heuristic passive-voice detector. Handles simple passives ("was observed")
 * and negated passives ("was not observed", "were not reported"). Not
 * linguistically exhaustive — calibrated to filter only egregious active-voice
 * dossier prose. Threshold tuned during end-to-end calibration in Phase 10.
 */
function passiveRatio(text: string): number {
    const sentences = text.split(/[.!?]\s+/).filter((s) => s.trim().length > 0);
    if (sentences.length === 0) return 1;
    const passive = sentences.filter((s) => /\b(is|are|was|were|been|being)\s+(?:not\s+)?\w+(ed|en)\b/.test(s)).length;
    return passive / sentences.length;
}

function findBannedPhrases(text: string): string[] {
    const hits: string[] = [];
    for (const banned of toxVoiceVocabulary.banned) {
        // Escape regex metacharacters first (`.`, `+`, `*`, `?`, `(`, `)`, etc.),
        // then allow either hyphen or space between hyphenated tokens.
        const escaped = banned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(`\\b${escaped.replace(/[-]/g, "[- ]")}\\b`, "i");
        if (pattern.test(text)) hits.push(banned);
    }
    return hits;
}

function findColloquialOrganRefs(text: string): string[] {
    const hits: string[] = [];
    for (const [pat, canonical] of COLLOQUIAL_ORGAN_SUBS) {
        if (pat.test(text)) hits.push(`${pat.source} → ${canonical}`);
    }
    return hits;
}

function hasHedge(text: string): boolean {
    const lc = text.toLowerCase();
    return toxVoiceVocabulary.hedgePhrases.some((h) => lc.includes(h.toLowerCase()));
}

function hasCitation(text: string): boolean {
    return CITATION_PATTERNS.some((p) => p.test(text));
}

function detectsEfficacyOrSafetyClaim(text: string): boolean {
    return EFFICACY_SAFETY_TRIGGERS.some((p) => p.test(text));
}

const PASSIVE_FAIL_THRESHOLD = 0.15;
const PASSIVE_RELAXED_THRESHOLD = 0.3;

export function buildVoiceCritique(text: string, _sectionType: SectionType): VoiceProbe {
    const output_chars = text.length;
    const issues: string[] = [];

    const banned = findBannedPhrases(text);
    if (banned.length > 0) {
        issues.push(`Banned phrase(s) detected: ${banned.join(", ")}.`);
    }

    const colloquial = findColloquialOrganRefs(text);
    if (colloquial.length > 0) {
        issues.push(`Non-canonical organ-system reference(s); use canonical organ-system vocabulary.`);
    }

    if (detectsEfficacyOrSafetyClaim(text) && !hasHedge(text) && !hasCitation(text)) {
        issues.push(
            "Efficacy/safety claim detected with no hedge phrase and no citation. Add a hedge from the approved set, a literature citation (PMID/DOI), or a regulatory reference (Drugs@FDA / ICH / FDA guidance).",
        );
    }

    if (issues.length > 0) {
        return {
            verdict: "fail-voice",
            critique: issues.join(" "),
            output_chars,
        };
    }

    // Hedge phrases and citations are primary voice signals. When either is
    // present the prose is already anchored in the correct register; the
    // passive-ratio heuristic is a secondary fallback for unanchored text only.
    if (!hasHedge(text) && !hasCitation(text)) {
        const passive = passiveRatio(text);
        if (passive < PASSIVE_FAIL_THRESHOLD) {
            return {
                verdict: "fail-voice",
                critique: `Passive-voice ratio ${passive.toFixed(2)} below floor ${PASSIVE_FAIL_THRESHOLD}; rewrite in third-person passive (study-summary cadence).`,
                output_chars,
            };
        }
        if (passive < PASSIVE_RELAXED_THRESHOLD) {
            return {
                verdict: "relaxed",
                critique: `Passive-voice ratio ${passive.toFixed(2)} below preferred ${PASSIVE_RELAXED_THRESHOLD}; rewrite in third-person passive (study-summary cadence) on next iteration.`,
                output_chars,
            };
        }
    }

    return { verdict: "pass", critique: "", output_chars };
}
