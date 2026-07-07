/**
 * Phase-5 synthesis functions for the harness DBOS workflow.
 *
 * Four functions:
 *   - `liabilityBullets`        (per-section, parallel-safe)
 *   - `safetyFlagsTrail`        (per-section, parallel-safe)
 *   - `translationalCommentary` (per-section, parallel-safe)
 *   - `dossierRecommendation`   (whole-dossier, sequential after the three above)
 *
 * Each function is a pure async `(input, deps) => Promise<EnvelopeWithDiagnostic>`.
 * Every call is single-shot structured-output through `structuredLlmCall`.
 *
 * The `runSynthesisWithProbe` helper preserves the bounded-retry-on-probe-
 * failure semantics: attempt 1 → probe → critique-driven retry → probe.
 * Each attempt is its own attempt-numbered DBOS step so a resumed
 * post-402 call lands a fresh cache slot.
 */

import { z } from "zod";

import { SynthesisDiagnosticRowSchema, type DossierV4Body, type SynthesisDiagnosticRow } from "@inflexa-ai/harness/contracts/target-dossier.js";
import {
    executiveRecommendationBrief,
    liabilityBulletsBrief,
    targetOrganLiabilitiesBrief,
    translationalCommentaryBrief,
} from "../../../prompts/target-assessment/briefs/index.js";
import { toxVoiceCore, toxVoiceExemplars, type SectionType } from "../../../prompts/target-assessment/tox-voice/index.js";
import { SerializedErrorSchema } from "../coverage.js";
import { buildDiagnosticsRow, type StepId } from "../steps/synthesis/diagnostics.js";
import { probeLiabilityBullets, probeRecommendation, probeSafetyFlags, probeTranslationalCommentary, type ProbeResult } from "../synthesis-probes.js";

import type { AgentSession } from "../../../auth/types.js";
import type { AgentChat } from "../../../providers/types.js";

import { BUDGET_EXCEEDED_SENTINEL } from "../lib/llm-step.js";
import { structuredLlmCall } from "../lib/structured-llm.js";

// ── Output schemas ────────────────────────────────────────────────────

export const LiabilityBulletsOutputSchema = z.object({
    bullets: z.array(
        z.object({
            organ_or_axis: z.string(),
            severity: z.enum(["high", "medium", "low"]),
            text: z.string(),
            evidence_pointer: z.string(),
            rationale: z.string(),
            category: z.enum(["fatal_post_market", "class_liability", "off_target_safety", "high_safety_organ_expression", "broad_expression", "other"]),
        }),
    ),
    notes: z.string(),
});
export type LiabilityBulletsOutput = z.infer<typeof LiabilityBulletsOutputSchema>;

export const SafetyFlagsTrailOutputSchema = z.object({
    flags: z.array(
        z.object({
            organ: z.string(),
            trail: z.string(),
            mechanism_hypothesis: z.string().nullable(),
        }),
    ),
});
export type SafetyFlagsTrailOutput = z.infer<typeof SafetyFlagsTrailOutputSchema>;

export const TranslationalCommentaryOutputSchema = z.object({
    rows: z.array(
        z.object({
            topic: z.enum(["ko_phenotype", "expression_translation", "organ_system_match", "family_context"]),
            predicate: z.string(),
            commentary: z.string(),
        }),
    ),
});
export type TranslationalCommentaryOutput = z.infer<typeof TranslationalCommentaryOutputSchema>;

export const ExternalCitationSchema = z.object({
    id: z.string(),
    kind: z.enum(["fda_anda", "fda_nda", "pubmed", "clinicaltrials", "regulatory_guidance"]),
    retrieved_via: z.string(),
    fetched_at: z.string().datetime().optional(),
    excerpt: z.string().max(500),
});
export type ExternalCitation = z.infer<typeof ExternalCitationSchema>;

export const DossierRecommendationOutputSchema = z.object({
    disposition: z.enum(["pursue", "conditional", "de_prioritize", "insufficient_evidence"]),
    confidence: z.enum(["high", "medium", "low"]),
    rationale: z.string(),
    key_strengths: z.array(z.string()),
    key_risks: z.array(z.string()),
    modality_choice: z.object({
        modality: z.string(),
        rationale: z.string(),
    }),
    coverage_qualifier: z.object({
        sections_consulted: z.array(z.string()),
        sections_unavailable: z.array(z.string()),
        note: z.string(),
    }),
    external_citations: z.array(ExternalCitationSchema).default([]),
});
export type DossierRecommendationOutput = z.infer<typeof DossierRecommendationOutputSchema>;

// ── Per-step envelope schemas ─────────────────────────────────────────

function withDiagnosticAndCoverage<TData extends z.ZodTypeAny>(dataSchema: TData) {
    return z.discriminatedUnion("coverage", [
        z.object({
            coverage: z.literal("available"),
            data: dataSchema,
            diagnostic: SynthesisDiagnosticRowSchema,
        }),
        z.object({
            coverage: z.literal("queried_no_data"),
            error: SerializedErrorSchema.extend({
                kind: z.enum(["synthesis-too-shallow", "synthesis-unavailable", "voice-violation"]).optional(),
            }).optional(),
            diagnostic: SynthesisDiagnosticRowSchema,
        }),
    ]);
}

export const LiabilityBulletsStepOutputSchema = withDiagnosticAndCoverage(LiabilityBulletsOutputSchema);
export type LiabilityBulletsStepOutput = z.infer<typeof LiabilityBulletsStepOutputSchema>;
export const SafetyFlagsTrailStepOutputSchema = withDiagnosticAndCoverage(SafetyFlagsTrailOutputSchema);
export type SafetyFlagsTrailStepOutput = z.infer<typeof SafetyFlagsTrailStepOutputSchema>;
export const TranslationalCommentaryStepOutputSchema = withDiagnosticAndCoverage(TranslationalCommentaryOutputSchema);
export type TranslationalCommentaryStepOutput = z.infer<typeof TranslationalCommentaryStepOutputSchema>;
export const DossierRecommendationStepOutputSchema = withDiagnosticAndCoverage(DossierRecommendationOutputSchema);
export type DossierRecommendationStepOutput = z.infer<typeof DossierRecommendationStepOutputSchema>;

// ── Dep bundle ───────────────────────────────────────────────────────

export interface SynthesisAgentDeps {
    readonly chatProvider: AgentChat;
    readonly session: AgentSession;
    readonly model: string;
    /** Attempt counter — bumped on resume so a 402-cancelled call lands a fresh DBOS step slot. */
    readonly attempt: number;
}

// ── Instruction composer ─────────────────────────────────────────────

function composeInstructions(brief: string, section: SectionType): string {
    const exemplarBlock = toxVoiceExemplars[section].map((ex, i) => `### Exemplar ${i + 1}\n\n${ex}`).join("\n\n");
    return [toxVoiceCore, "---", brief, "---", "## Voice exemplars", exemplarBlock].join("\n\n");
}

// ── Budget-exceeded sentinel ─────────────────────────────────────────

export type SynthesisStepResult<TStepOutput> = TStepOutput | { readonly kind: "budget-exceeded"; readonly sentinel: typeof BUDGET_EXCEEDED_SENTINEL };

function isBudgetExceeded<T>(v: SynthesisStepResult<T>): v is { kind: "budget-exceeded"; sentinel: typeof BUDGET_EXCEEDED_SENTINEL } {
    return typeof v === "object" && v !== null && "kind" in v && (v as { kind: string }).kind === "budget-exceeded";
}

// ── runSynthesisWithProbe ────────────────────────────────────────────

interface SynthesisDriverInput<TOut> {
    readonly stepId: StepId;
    readonly modelId: string;
    readonly system: string;
    readonly basePrompt: string;
    readonly outputSchema: z.ZodType<TOut>;
    readonly probe: (out: TOut) => ProbeResult;
    readonly chatProvider: AgentChat;
    readonly session: AgentSession;
    /** Base step name (without `:attempt`) — wrapper appends `:0` / `:1`. */
    readonly baseStepName: string;
}

interface SynthesisDriverOk<TOut> {
    readonly kind: "ok";
    readonly finalOut: TOut | null;
    readonly diagnostic: SynthesisDiagnosticRow;
    readonly errorKind: "synthesis-too-shallow" | "synthesis-unavailable" | "voice-violation" | null;
    readonly errorMessage: string | null;
}

type SynthesisDriverResult<TOut> = SynthesisDriverOk<TOut> | { readonly kind: "budget-exceeded"; readonly sentinel: typeof BUDGET_EXCEEDED_SENTINEL };

/**
 * Run a synthesis call with one bounded retry on probe failure. Returns
 * the final output (or null on permanent failure) plus a diagnostics row.
 * On a billing-gateway 402 at any attempt, propagates the budget-exceeded sentinel.
 */
async function runSynthesisWithProbe<TOut>(input: SynthesisDriverInput<TOut>): Promise<SynthesisDriverResult<TOut>> {
    let firstError: Error | null = null;
    let firstProbe: ProbeResult | null = null;

    // Attempt 1
    try {
        const result = await structuredLlmCall<z.ZodType<TOut>>({
            stepName: `${input.baseStepName}:0`,
            agentId: input.stepId,
            provider: input.chatProvider,
            session: input.session,
            system: input.system,
            prompt: input.basePrompt,
            schema: input.outputSchema,
            model: input.modelId,
        });
        if (result.kind === "budget-exceeded") {
            return { kind: "budget-exceeded", sentinel: result.sentinel };
        }
        const firstOutput = result.value;
        firstProbe = input.probe(firstOutput);
        if (firstProbe.verdict === "pass" || firstProbe.verdict === "relaxed") {
            return {
                kind: "ok",
                finalOut: firstOutput,
                diagnostic: buildDiagnosticsRow({
                    stepId: input.stepId,
                    modelId: input.modelId,
                    attemptCount: 1,
                    retryCritique: null,
                    finalProbe: firstProbe,
                    finalCoverage: "available",
                }),
                errorKind: null,
                errorMessage: null,
            };
        }
    } catch (err) {
        firstError = err instanceof Error ? err : new Error(String(err));
    }

    // Attempt 2 — critique-driven retry. On hard first-attempt throw, the
    // retry uses the base prompt prefixed with the throw message.
    const retryCritique = firstProbe?.critique ?? (firstError ? `Your prior attempt threw: ${firstError.message}. Try again.` : null);
    const retryPrompt = retryCritique != null ? `${input.basePrompt}\n\n---\n\nIMPORTANT: ${retryCritique}` : input.basePrompt;

    try {
        const result = await structuredLlmCall<z.ZodType<TOut>>({
            stepName: `${input.baseStepName}:1`,
            agentId: input.stepId,
            provider: input.chatProvider,
            session: input.session,
            system: input.system,
            prompt: retryPrompt,
            schema: input.outputSchema,
            model: input.modelId,
        });
        if (result.kind === "budget-exceeded") {
            return { kind: "budget-exceeded", sentinel: result.sentinel };
        }
        const retryOutput = result.value;
        const retryProbe = input.probe(retryOutput);
        if (retryProbe.verdict === "pass" || retryProbe.verdict === "relaxed") {
            return {
                kind: "ok",
                finalOut: retryOutput,
                diagnostic: buildDiagnosticsRow({
                    stepId: input.stepId,
                    modelId: input.modelId,
                    attemptCount: 2,
                    retryCritique,
                    finalProbe: retryProbe,
                    finalCoverage: "available",
                }),
                errorKind: null,
                errorMessage: null,
            };
        }
        const errorKind: "synthesis-too-shallow" | "voice-violation" = retryProbe.verdict === "fail-voice" ? "voice-violation" : "synthesis-too-shallow";
        return {
            kind: "ok",
            finalOut: null,
            diagnostic: buildDiagnosticsRow({
                stepId: input.stepId,
                modelId: input.modelId,
                attemptCount: 2,
                retryCritique,
                finalProbe: retryProbe,
                finalCoverage: "queried_no_data",
                errorKind,
                errorMessage: retryProbe.critique,
            }),
            errorKind,
            errorMessage: retryProbe.critique,
        };
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return {
            kind: "ok",
            finalOut: null,
            diagnostic: buildDiagnosticsRow({
                stepId: input.stepId,
                modelId: input.modelId,
                attemptCount: 2,
                retryCritique,
                finalProbe: firstProbe ?? {
                    verdict: "skipped",
                    critique: errMsg,
                    output_chars: 0,
                },
                finalCoverage: "queried_no_data",
                errorKind: "synthesis-unavailable",
                errorMessage: errMsg,
            }),
            errorKind: "synthesis-unavailable",
            errorMessage: errMsg,
        };
    }
}

// ── Per-section synthesis functions ──────────────────────────────────

interface Phase4Output {
    readonly assessmentId: string;
    readonly dossier: DossierV4Body;
}

function envelopeFromDriverResult<TData>(driver: SynthesisDriverOk<TData>):
    | { coverage: "available"; data: TData; diagnostic: SynthesisDiagnosticRow }
    | {
          coverage: "queried_no_data";
          error: { message: string; name: string; kind: string };
          diagnostic: SynthesisDiagnosticRow;
      } {
    if (driver.finalOut) {
        return {
            coverage: "available",
            data: driver.finalOut,
            diagnostic: driver.diagnostic,
        };
    }
    return {
        coverage: "queried_no_data",
        error: {
            message: driver.errorMessage ?? "synthesis failed",
            name: driver.errorKind ?? "synthesis-unavailable",
            kind: driver.errorKind ?? "synthesis-unavailable",
        },
        diagnostic: driver.diagnostic,
    };
}

export async function liabilityBullets(phase4: Phase4Output, deps: SynthesisAgentDeps): Promise<SynthesisStepResult<LiabilityBulletsStepOutput>> {
    const prompt = [
        "Phase-4 dossier — write evidence-cited liability bullets.",
        "The full assembled dossier follows. Cite section paths and counts; do not fabricate.",
        "",
        JSON.stringify(phase4.dossier, null, 2),
    ].join("\n");

    const result = await runSynthesisWithProbe<LiabilityBulletsOutput>({
        stepId: "liability-bullets",
        modelId: deps.model,
        system: composeInstructions(liabilityBulletsBrief, "liability-bullets"),
        basePrompt: prompt,
        outputSchema: LiabilityBulletsOutputSchema,
        probe: (out) => probeLiabilityBullets(out, phase4.dossier),
        chatProvider: deps.chatProvider,
        session: deps.session,
        baseStepName: `ta-synth:liability-bullets:${deps.attempt}`,
    });
    if (result.kind === "budget-exceeded") return result;
    return envelopeFromDriverResult(result) as LiabilityBulletsStepOutput;
}

export async function safetyFlagsTrail(phase4: Phase4Output, deps: SynthesisAgentDeps): Promise<SynthesisStepResult<SafetyFlagsTrailStepOutput>> {
    const prompt = [
        "Phase-4 dossier — write per-organ safety-flag audit trails.",
        "The full assembled dossier follows. Cite source counts; do not fabricate.",
        "",
        JSON.stringify(phase4.dossier, null, 2),
    ].join("\n");

    const result = await runSynthesisWithProbe<SafetyFlagsTrailOutput>({
        stepId: "safety-flags-trail",
        modelId: deps.model,
        system: composeInstructions(targetOrganLiabilitiesBrief, "target-organ-liabilities"),
        basePrompt: prompt,
        outputSchema: SafetyFlagsTrailOutputSchema,
        probe: probeSafetyFlags,
        chatProvider: deps.chatProvider,
        session: deps.session,
        baseStepName: `ta-synth:safety-flags-trail:${deps.attempt}`,
    });
    if (result.kind === "budget-exceeded") return result;
    return envelopeFromDriverResult(result) as SafetyFlagsTrailStepOutput;
}

export async function translationalCommentary(phase4: Phase4Output, deps: SynthesisAgentDeps): Promise<SynthesisStepResult<TranslationalCommentaryStepOutput>> {
    const prompt = [
        "Phase-4 dossier — write preclinical-to-clinical translational commentary.",
        "The full assembled dossier follows. Cite tissues and species literally; do not fabricate.",
        "",
        JSON.stringify(phase4.dossier, null, 2),
    ].join("\n");

    const result = await runSynthesisWithProbe<TranslationalCommentaryOutput>({
        stepId: "translational-commentary",
        modelId: deps.model,
        system: composeInstructions(translationalCommentaryBrief, "translational-commentary"),
        basePrompt: prompt,
        outputSchema: TranslationalCommentaryOutputSchema,
        probe: probeTranslationalCommentary,
        chatProvider: deps.chatProvider,
        session: deps.session,
        baseStepName: `ta-synth:translational-commentary:${deps.attempt}`,
    });
    if (result.kind === "budget-exceeded") return result;
    return envelopeFromDriverResult(result) as TranslationalCommentaryStepOutput;
}

// ── Whole-dossier recommendation ─────────────────────────────────────

export interface DossierRecommendationInput {
    readonly phase4: Phase4Output;
    readonly perSection: {
        readonly liabilityBullets: LiabilityBulletsStepOutput;
        readonly safetyFlagsTrail: SafetyFlagsTrailStepOutput;
        readonly translationalCommentary: TranslationalCommentaryStepOutput;
    };
}

export async function dossierRecommendation(
    input: DossierRecommendationInput,
    deps: SynthesisAgentDeps,
): Promise<SynthesisStepResult<DossierRecommendationStepOutput>> {
    // Surface just the data envelopes from the per-section synthesis outputs;
    // drop the diagnostic so the recommendation agent isn't tempted to read
    // its own machinery.
    const perSectionPrompt = {
        liability_bullets:
            input.perSection.liabilityBullets.coverage === "available" ? input.perSection.liabilityBullets.data : { coverage: "queried_no_data" },
        target_organ_liabilities:
            input.perSection.safetyFlagsTrail.coverage === "available" ? input.perSection.safetyFlagsTrail.data : { coverage: "queried_no_data" },
        translational_commentary:
            input.perSection.translationalCommentary.coverage === "available" ? input.perSection.translationalCommentary.data : { coverage: "queried_no_data" },
    };

    const prompt = [
        "Phase-4 dossier — produce the executive recommendation.",
        "Inputs are: (1) the full assembled dossier, (2) the three per-section synthesis outputs.",
        "Cite at least three section paths from the dossier, integrate the per-section bullets/flags/commentary, and disclose coverage gaps explicitly.",
        "",
        JSON.stringify({ dossier: input.phase4.dossier, per_section_synthesis: perSectionPrompt }, null, 2),
    ].join("\n");

    const result = await runSynthesisWithProbe<DossierRecommendationOutput>({
        stepId: "dossier-recommendation",
        modelId: deps.model,
        system: composeInstructions(executiveRecommendationBrief, "executive-recommendation"),
        basePrompt: prompt,
        outputSchema: DossierRecommendationOutputSchema,
        probe: (out) => probeRecommendation(out, input.phase4.dossier),
        chatProvider: deps.chatProvider,
        session: deps.session,
        baseStepName: `ta-synth:dossier-recommendation:${deps.attempt}`,
    });
    if (result.kind === "budget-exceeded") return result;
    return envelopeFromDriverResult(result) as DossierRecommendationStepOutput;
}

export { isBudgetExceeded as isSynthesisBudgetExceeded };
