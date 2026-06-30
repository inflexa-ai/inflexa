/**
 * Synthesis content probes — deterministic floor on Phase-5 LLM output
 * depth.
 *
 * Each per-section synthesis step runs its agent's structured output
 * through the relevant probe before accepting it. A failed probe
 * triggers one bounded retry with a critique appended; a second failure
 * marks the section `coverage: "queried_no_data"` with
 * `error.kind: "synthesis-too-shallow"` (the workflow proceeds — the
 * dossier still persists with the rest of the data intact).
 *
 * Probes are deliberately deterministic regex/length checks — not
 * LLM-as-judge. The prompts already require evidence citation; the
 * probes are a regression-prevention floor for the rare LLM regression
 * that produces fragment-length output anyway.
 *
 * Threshold tuning: the constants block at the top of this file is the
 * single source of truth. Adjust there, never inline.
 */

import type { DossierV4Body, DossierV5Body } from "@inflexa-ai/harness/contracts/target-dossier.js";
import type { DossierRecommendationOutput, LiabilityBulletsOutput, SafetyFlagsTrailOutput, TranslationalCommentaryOutput } from "./synthesis/index.js";
import { buildVoiceCritique, type SectionType } from "../../prompts/target-assessment/tox-voice/index.js";

// ── Tunable thresholds ───────────────────────────────────────────────

export const PROBE_THRESHOLDS = {
    recommendation: {
        rationaleMinChars: 600,
        rationaleMinCharsRelaxed: 200,
        requiredSectionRefs: 3,
        requiredKeyItems: 1,
    },
    liabilityBullet: {
        rationaleMinChars: 80,
        requiresSourceOrCounter: true,
    },
    safetyFlag: {
        trailMinChars: 100,
        requiredSourceRefs: 2,
    },
    translationalCommentary: {
        commentaryMinChars: 120,
    },
} as const;

// ── Probe verdict types ──────────────────────────────────────────────

export type ProbeVerdict =
    | "pass"
    | "fail-length"
    | "fail-section-references"
    | "fail-key-strengths-risks"
    | "fail-source-references"
    | "fail-numeric-claim"
    | "fail-voice"
    | "relaxed"
    | "skipped";

export interface ProbeResult {
    verdict: ProbeVerdict;
    critique: string | null;
    output_chars: number;
}

// ── Helpers: substring matching ──────────────────────────────────────

const KNOWN_SECTION_NAMES = [
    "safety_profile",
    "tractability",
    "indications",
    "clinical_development",
    "reference_biology.preclinical",
    "reference_biology",
    "analytics.translational_chain",
    "off_target_panel",
    "off_tissue_risk",
    "drug_interactions",
    "liability_summary",
    "summary",
] as const;

const KNOWN_SOURCE_NAMES = ["FAERS", "trial AEs", "off-target panel", "class precedent"] as const;

export function countSectionReferences(text: string): { matchedSections: string[] } {
    const lower = text.toLowerCase();
    const matched = new Set<string>();
    for (const name of KNOWN_SECTION_NAMES) {
        if (lower.includes(name.toLowerCase())) {
            matched.add(name);
        }
    }
    // Treat `reference_biology.preclinical` as more specific than
    // `reference_biology`; if both match, only count the more specific.
    if (matched.has("reference_biology.preclinical")) {
        matched.delete("reference_biology");
    }
    return { matchedSections: [...matched] };
}

export function countSourceReferences(text: string): { matchedSources: string[] } {
    const lower = text.toLowerCase();
    const matched = new Set<string>();
    for (const name of KNOWN_SOURCE_NAMES) {
        if (lower.includes(name.toLowerCase())) matched.add(name);
    }
    return { matchedSources: [...matched] };
}

const NUMERIC_COUNTER_RE = /\b\d+(?:\.\d+)?(?:\s*(?:%|µm|um|fold|drugs?|reports?|signals?|trials?|tissues?|sources?|years?))?/i;

function hasNumericCounter(text: string): boolean {
    return NUMERIC_COUNTER_RE.test(text);
}

// ── Numeric-claim verifier ───────────────────────────────────────────

// Matches a "≥/>= N nTPM in M (distinct) tissues" count claim. The GLP1R
// dossier review found a bullet asserting "≥10 nTPM in 14 distinct tissues"
// when normal_tissue_expression actually held 23 — a class of miscount the
// length/source probes cannot catch.
const TISSUE_COUNT_CLAIM_RE = /(?:≥|>=)\s*(\d+(?:\.\d+)?)\s*ntpm\s+in\s+(\d+)\s+(?:distinct\s+)?tissues/i;

/**
 * Verify a bullet's "≥N nTPM in M tissues" claim against
 * `reference_biology.normal_tissue_expression`. Returns a critique string
 * on mismatch, or `null` when there is no such claim, no dossier, or the
 * expression section is not available (nothing to verify against).
 */
function verifyTissueCountClaim(text: string, dossier: DossierV4Body | DossierV5Body | undefined): string | null {
    if (!dossier) return null;
    const nte = dossier.reference_biology?.normal_tissue_expression;
    if (!nte || nte.coverage !== "available") return null;
    // Raw GTEx `tpm` values are not on the normalized nTPM scale a "≥N nTPM"
    // bullet claim refers to — comparing them would be meaningless. `ntpm` and
    // `consensus_normalized` are both nTPM-scale and ARE verified.
    if (nte.data.unit === "tpm") return null;
    const m = text.match(TISSUE_COUNT_CLAIM_RE);
    if (!m) return null;
    const threshold = parseFloat(m[1]!);
    const claimed = parseInt(m[2]!, 10);
    const actual = nte.data.rows.filter((r) => typeof r.value === "number" && r.value >= threshold).length;
    if (claimed === actual) return null;
    return (
        `Bullet claims "${m[0]}" but normal_tissue_expression has ${actual} ` +
        `tissue(s) with value ≥ ${threshold} nTPM, not ${claimed}. ` +
        `Correct the count to ${actual}.`
    );
}

// ── Voice composition helper ─────────────────────────────────────────

/**
 * Compose a base probe result with a voice check.
 *
 * Length fails are hard — a too-short output cannot be redeemed by
 * good voice. All other fails (source, section-refs, key-items) are
 * overridable: a banned-phrase violation is reported in preference to
 * an incomplete source citation, because voice is the narrower and
 * more actionable failure for the retry prompt.
 *
 * When the base is a clean pass, voice can still flip the verdict to
 * "fail-voice" (banned phrases / wrong register) or downgrade to
 * "relaxed" (borderline passive ratio).
 */
function composeWithVoice(base: ProbeResult, text: string, section: SectionType): ProbeResult {
    if (base.verdict === "fail-length") {
        // A too-short output cannot be redeemed by good voice, so the verdict
        // stays fail-length. But surface any voice issues in the critique too —
        // the single bounded retry should be able to fix length AND voice in
        // one pass, not discover the voice problem only on its final attempt.
        const voice = buildVoiceCritique(text, section);
        if (voice.verdict === "fail-voice" && voice.critique) {
            return {
                ...base,
                critique: `${base.critique ?? ""}\n\nAdditionally: ${voice.critique}`,
            };
        }
        return base;
    }
    const voice = buildVoiceCritique(text, section);
    if (voice.verdict === "fail-voice") {
        return {
            verdict: "fail-voice",
            critique: voice.critique,
            output_chars: base.output_chars,
        };
    }
    if (voice.verdict === "relaxed" && base.verdict === "pass") {
        return {
            verdict: "relaxed",
            critique: voice.critique,
            output_chars: base.output_chars,
        };
    }
    return base;
}

// ── Recommendation probe ─────────────────────────────────────────────

function recommendationCoverageRelaxed(dossier: DossierV4Body | DossierV5Body): boolean {
    // Relax probe rules when the dossier is genuinely thin — at least two
    // of the three "primary" evidence streams must be unavailable.
    const probes = [
        dossier.safety_profile.organ_rollup.coverage !== "available",
        dossier.clinical_development.trials.coverage !== "available",
        dossier.reference_biology.preclinical.data_coverage.ko !== "available",
    ];
    return probes.filter(Boolean).length >= 2;
}

export function probeRecommendation(out: DossierRecommendationOutput, dossier: DossierV4Body | DossierV5Body): ProbeResult {
    const t = PROBE_THRESHOLDS.recommendation;
    const len = out.rationale.length;
    const relaxed = recommendationCoverageRelaxed(dossier);

    // Build the prose payload up-front so the voice probe runs on every
    // path — including the fail-length branch. Banned phrases and
    // colloquial organ-system references have no data-coverage dependency
    // and must be caught regardless of how thin the upstream evidence is.
    const recommendationText = [out.rationale, out.key_strengths.join(" "), out.key_risks.join(" "), out.modality_choice.rationale].join("\n");

    // Length floor (minimum applies even when relaxed).
    const minLen = relaxed ? t.rationaleMinCharsRelaxed : t.rationaleMinChars;
    if (len < minLen) {
        return composeWithVoice(
            {
                verdict: "fail-length",
                critique: `Your prior rationale was ${len} characters; rewrite to ≥ ${minLen} characters integrating the dossier's evidence.`,
                output_chars: len,
            },
            recommendationText,
            "executive-recommendation",
        );
    }

    if (relaxed) {
        // Coverage is thin: do not require section-reference count or
        // key-strengths/risks. Voice probe still applies. Returns "relaxed"
        // when voice is clean so diagnostics reflect that the strict rules
        // were not applied.
        return composeWithVoice({ verdict: "relaxed", critique: null, output_chars: len }, recommendationText, "executive-recommendation");
    }

    // Section-reference and key-item content fails are routed through
    // composeWithVoice so a banned-phrase / colloquial-organ violation can
    // override them. Voice fails are narrower and more actionable for the
    // single retry budget — getting both issues into one critique is the
    // difference between a recoverable section and a permanent
    // queried_no_data drop.
    const { matchedSections } = countSectionReferences(out.rationale);
    if (matchedSections.length < t.requiredSectionRefs) {
        return composeWithVoice(
            {
                verdict: "fail-section-references",
                critique: `Your rationale referenced ${matchedSections.length} dossier section(s) (${matchedSections.join(", ") || "none"}); rewrite to cite ≥ ${t.requiredSectionRefs} of: safety_profile, tractability, indications, clinical_development, reference_biology.preclinical, analytics.translational_chain, off_target_panel.`,
                output_chars: len,
            },
            recommendationText,
            "executive-recommendation",
        );
    }
    if (out.key_strengths.length < t.requiredKeyItems || out.key_risks.length < t.requiredKeyItems) {
        return composeWithVoice(
            {
                verdict: "fail-key-strengths-risks",
                critique: `key_strengths (${out.key_strengths.length}) and key_risks (${out.key_risks.length}) must each have ≥ ${t.requiredKeyItems} entry when overall data coverage allows it.`,
                output_chars: len,
            },
            recommendationText,
            "executive-recommendation",
        );
    }

    return composeWithVoice({ verdict: "pass", critique: null, output_chars: len }, recommendationText, "executive-recommendation");
}

// ── Liability bullet probe ───────────────────────────────────────────

export function probeLiabilityBullets(out: LiabilityBulletsOutput, dossier?: DossierV4Body | DossierV5Body): ProbeResult {
    const t = PROBE_THRESHOLDS.liabilityBullet;
    if (out.bullets.length === 0) {
        // An empty bullets array is acceptable when `notes` discloses why.
        if (out.notes.length >= 60) {
            return { verdict: "pass", critique: null, output_chars: out.notes.length };
        }
        return {
            verdict: "fail-length",
            critique: `Empty bullets array with insufficient disclosure note (${out.notes.length} chars). Either populate at least one bullet or expand notes to ≥ 60 chars explaining the data picture.`,
            output_chars: out.notes.length,
        };
    }

    const totalChars = out.bullets.reduce((acc, b) => acc + b.rationale.length, 0);
    const bulletText = out.bullets.map((b) => `${b.text}\n${b.rationale}`).join("\n");
    for (const b of out.bullets) {
        if (b.rationale.length < t.rationaleMinChars) {
            return composeWithVoice(
                {
                    verdict: "fail-length",
                    critique: `Bullet "${b.organ_or_axis}" rationale is ${b.rationale.length} chars; rewrite to ≥ ${t.rationaleMinChars} chars citing a numeric counter or a source by name.`,
                    output_chars: totalChars,
                },
                bulletText,
                "liability-bullets",
            );
        }
        if (t.requiresSourceOrCounter) {
            const { matchedSources } = countSourceReferences(b.rationale);
            const counter = hasNumericCounter(b.rationale);
            if (matchedSources.length === 0 && !counter) {
                const sourceFailBase: ProbeResult = {
                    verdict: "fail-source-references",
                    critique: `Bullet "${b.organ_or_axis}" rationale cites no source (FAERS, trial AEs, off-target panel, class precedent) and no numeric counter; rewrite citing one or both.`,
                    output_chars: totalChars,
                };
                return composeWithVoice(sourceFailBase, bulletText, "liability-bullets");
            }
        }
    }

    for (const b of out.bullets) {
        const numericCritique = verifyTissueCountClaim(b.text, dossier);
        if (numericCritique) {
            return {
                verdict: "fail-numeric-claim",
                critique: numericCritique,
                output_chars: totalChars,
            };
        }
    }

    return composeWithVoice({ verdict: "pass", critique: null, output_chars: totalChars }, bulletText, "liability-bullets");
}

// ── Safety flag probe ────────────────────────────────────────────────

export function probeSafetyFlags(out: SafetyFlagsTrailOutput): ProbeResult {
    const t = PROBE_THRESHOLDS.safetyFlag;
    if (out.flags.length === 0) {
        return { verdict: "pass", critique: null, output_chars: 0 };
    }
    const totalChars = out.flags.reduce((acc, f) => acc + f.trail.length, 0);
    const flagText = out.flags.map((f) => `${f.organ}: ${f.trail} ${f.mechanism_hypothesis ?? ""}`).join("\n");
    for (const f of out.flags) {
        if (f.trail.length < t.trailMinChars) {
            return composeWithVoice(
                {
                    verdict: "fail-length",
                    critique: `Flag for "${f.organ}" trail is ${f.trail.length} chars; rewrite to ≥ ${t.trailMinChars} chars citing specific source counts.`,
                    output_chars: totalChars,
                },
                flagText,
                "target-organ-liabilities",
            );
        }
        const { matchedSources } = countSourceReferences(f.trail);
        if (matchedSources.length < t.requiredSourceRefs) {
            const sourceFailBase: ProbeResult = {
                verdict: "fail-source-references",
                critique: `Flag for "${f.organ}" cites ${matchedSources.length} source(s) (${matchedSources.join(", ") || "none"}); rewrite citing ≥ ${t.requiredSourceRefs} of: FAERS, trial AEs, off-target panel, class precedent.`,
                output_chars: totalChars,
            };
            return composeWithVoice(sourceFailBase, flagText, "target-organ-liabilities");
        }
    }
    return composeWithVoice({ verdict: "pass", critique: null, output_chars: totalChars }, flagText, "target-organ-liabilities");
}

// ── Translational commentary probe ───────────────────────────────────

export function probeTranslationalCommentary(out: TranslationalCommentaryOutput): ProbeResult {
    const t = PROBE_THRESHOLDS.translationalCommentary;
    if (out.rows.length === 0) {
        return { verdict: "pass", critique: null, output_chars: 0 };
    }
    const totalChars = out.rows.reduce((acc, r) => acc + r.commentary.length, 0);
    const commentaryText = out.rows.map((r) => `${r.predicate} ${r.commentary}`).join("\n");
    for (const r of out.rows) {
        if (r.commentary.length < t.commentaryMinChars) {
            return composeWithVoice(
                {
                    verdict: "fail-length",
                    critique: `Row "${r.topic}" commentary is ${r.commentary.length} chars; rewrite to ≥ ${t.commentaryMinChars} chars bridging preclinical observation to human prediction.`,
                    output_chars: totalChars,
                },
                commentaryText,
                "translational-commentary",
            );
        }
    }
    return composeWithVoice({ verdict: "pass", critique: null, output_chars: totalChars }, commentaryText, "translational-commentary");
}
