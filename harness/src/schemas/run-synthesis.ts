/**
 * Run synthesis schema — cross-step findings grounded in literature.
 *
 * Produced by the synthesis step after all sandbox steps complete.
 * Combines computational findings from step summaries with literature
 * evidence from the literature-reviewer agent.
 */

import { z } from "zod";

export const LiteratureReferenceSchema = z.object({
    pmid: z.string(),
    citation: z.string(),
    relevance: z.string(),
    concordance: z.enum(["supports", "contradicts", "extends", "contextualizes"]),
});

export const SynthesizedFindingSchema = z.object({
    /** Which step produced this finding. */
    stepId: z.string(),
    /** Finding title from the step summary. */
    title: z.string(),
    /** Finding description from the step summary. */
    description: z.string(),
    /** Confidence from the step summary. */
    confidence: z.enum(["high", "medium", "low"]),
    /** Novelty assessment based on literature review. */
    noveltyStatus: z.enum(["novel", "confirmed", "partially_confirmed", "contradicted", "expected"]),
    /** How this finding relates to existing literature. */
    literatureInterpretation: z.string(),
    /** Supporting or contradicting references. */
    references: z.array(LiteratureReferenceSchema),
    /** Translational proximity and actionability assessment. */
    translationalRelevance: z
        .object({
            /** How close this finding is to clinical application. */
            stage: z.enum(["discovery", "preclinical-validation", "biomarker-candidate", "clinical-evidence"]),
            /** What type of translational action this finding supports. */
            actionType: z
                .enum([
                    "therapeutic-target",
                    "predictive-biomarker",
                    "prognostic-biomarker",
                    "pharmacodynamic-biomarker",
                    "safety-signal",
                    "resistance-mechanism",
                    "patient-stratification",
                    "mechanism-of-action",
                    "none",
                ])
                .optional(),
            /** Brief rationale for the stage and action type. */
            rationale: z.string(),
        })
        .optional(),
});

export const BiologicalThemeSchema = z.object({
    /** Theme name, e.g. "Immune dysregulation", "Metabolic reprogramming". */
    name: z.string(),
    /** Findings that contribute to this theme (by stepId + title). */
    findings: z.array(z.object({ stepId: z.string(), title: z.string() })),
    /** How these findings connect into a coherent biological story. */
    narrative: z.string(),
});

export const RunSynthesisSchema = z.object({
    runId: z.string(),
    /** Brief (2-4 sentence) summary of the run's scope and top-line result. */
    overview: z.string(),
    /**
     * Integrated interpretation: what the run establishes, what is novel,
     * what is actionable from a translational perspective. This is the
     * primary interpretive section — the "so what" of the analysis.
     */
    conclusions: z.string(),
    /**
     * Selective findings — only novel, contradicted, or high-impact results
     * that warrant individual attention. NOT a per-step catalog.
     */
    findings: z.array(SynthesizedFindingSchema),
    /** Cross-step biological themes. */
    themes: z.array(BiologicalThemeSchema),
    /** Methodological and translational caveats. */
    limitations: z.array(z.string()),
    /** Key references across all findings. */
    keyReferences: z.array(
        z.object({
            pmid: z.string(),
            citation: z.string(),
            description: z.string(),
        }),
    ),
});

export type RunSynthesis = z.infer<typeof RunSynthesisSchema>;
export type SynthesizedFinding = z.infer<typeof SynthesizedFindingSchema>;
export type BiologicalTheme = z.infer<typeof BiologicalThemeSchema>;
export type LiteratureReference = z.infer<typeof LiteratureReferenceSchema>;
