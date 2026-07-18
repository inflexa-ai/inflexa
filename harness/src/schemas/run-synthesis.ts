/**
 * Run synthesis schema — cross-step findings grounded in literature.
 *
 * Produced by the synthesis step after all sandbox steps complete.
 * Combines computational findings from step summaries with literature
 * evidence from the literature-reviewer agent.
 *
 * This schema is the synthesizer's output contract: it is emitted as the
 * `submit_synthesis` tool's arg schema, so every field's meaning must live in
 * `.describe()` — a JSDoc comment here reaches no model.
 */

import { z } from "zod";

export const LiteratureReferenceSchema = z.object({
    pmid: z.string().describe("Numeric PubMed ID. Must come from a literature_reviewer response — never invented."),
    citation: z.string().describe('Short citation for the paper, e.g. "Smith 2020".'),
    relevance: z.string().describe("Why this paper matters to the finding — what it establishes, challenges, or contextualizes."),
    concordance: z
        .enum(["supports", "contradicts", "extends", "contextualizes"])
        .describe(
            "How the paper relates to the finding. " +
                "supports: the paper directly supports the finding. " +
                "contradicts: the paper reports a conflicting result. " +
                "extends: the paper builds on the finding in another context. " +
                "contextualizes: the paper provides background but does not directly address the finding.",
        ),
});

export const SynthesizedFindingSchema = z.object({
    stepId: z.string().describe("Which step produced this finding. Must be a stepId present in the input summaries."),
    title: z.string().describe("Finding title from the step summary."),
    description: z.string().describe("Finding description from the step summary."),
    confidence: z
        .enum(["high", "medium", "low"])
        .describe(
            "Confidence from the step summary — reflect the summary's own stated confidence, not a re-assessment. " +
                "If the summary states none, use medium; use high only for findings the summary treats as robust.",
        ),
    noveltyStatus: z
        .enum(["novel", "confirmed", "partially_confirmed", "contradicted", "expected"])
        .describe(
            "Novelty assessment based on literature review. " +
                "novel: the literature does not describe this result in this context. " +
                "confirmed: the literature independently establishes this result. " +
                "partially_confirmed: the literature supports related but not identical claims (e.g. same gene, different tissue). " +
                "contradicted: the literature reports the opposite direction or effect. " +
                "expected: a standard, well-known result (housekeeping genes, canonical QC outcomes) — not a discovery.",
        ),
    literatureInterpretation: z.string().describe("How this finding relates to existing literature."),
    references: z.array(LiteratureReferenceSchema).describe("Supporting or contradicting references."),
    translationalRelevance: z
        .object({
            stage: z
                .enum(["discovery", "preclinical-validation", "biomarker-candidate", "clinical-evidence"])
                .describe(
                    "How close this finding is to clinical application. " +
                        "discovery: novel biology with no direct clinical path yet. " +
                        "preclinical-validation: known target/pathway with existing preclinical evidence but no clinical data in this context. " +
                        "biomarker-candidate: measurable, differential, with a biologically plausible mechanism linking it to outcome. " +
                        "clinical-evidence: supported by or directly relevant to clinical trial data or approved therapeutics.",
                ),
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
                .optional()
                .describe(
                    "What type of translational action this finding supports. " +
                        "therapeutic-target: gene/protein/pathway suitable for drug intervention. " +
                        "predictive-biomarker: differentiates treatment responders from non-responders (requires treatment x marker interaction evidence). " +
                        "prognostic-biomarker: predicts outcome regardless of treatment. " +
                        "pharmacodynamic-biomarker: measures target engagement or drug effect over time. " +
                        "safety-signal: suggests potential toxicity, adverse effect, or off-target liability. " +
                        "resistance-mechanism: explains non-response or acquired resistance. " +
                        "patient-stratification: enables subgroup identification for enrichment strategies. " +
                        "mechanism-of-action: illuminates how a drug or intervention works. " +
                        "none: biological value but no direct translational path.",
                ),
            rationale: z
                .string()
                .describe(
                    "ONE sentence on why this stage and action type were assigned. " +
                        "Must reference specific evidence (existing drugs, clinical trials, biomarker properties, literature).",
                ),
        })
        .optional()
        .describe(
            "Translational proximity and actionability. Populate only for findings with genuine translational implications — " +
                "omit for purely technical or methodological findings.",
        ),
});

export const BiologicalThemeSchema = z.object({
    name: z
        .string()
        .describe(
            'Theme name — a conclusion, not a topic label. "ECM remodeling drives the NAFLD-to-NASH transition" is a theme; ' +
                '"Differential expression results" is not.',
        ),
    findings: z
        .array(z.object({ stepId: z.string(), title: z.string() }))
        .describe("Findings that contribute to this theme. Each entry must match an entry in findings[] by stepId + title."),
    narrative: z.string().describe("How these findings connect into a coherent biological story — 3-5 sentences connecting them, not restating them."),
});

export const KeyReferenceSchema = z.object({
    pmid: z.string().describe("Numeric PubMed ID. Must already appear in at least one finding's references[]."),
    citation: z.string().describe('Short citation for the paper, e.g. "Smith 2020".'),
    description: z.string().describe("What the paper establishes and why it is key to this run."),
});

export const RunSynthesisSchema = z.object({
    runId: z.string().describe("The run being synthesized. Must equal the runId given in the prompt."),
    overview: z
        .string()
        .describe(
            "2-4 sentences: the run's scope, the top-line result, and the most important takeaway. " +
                "An abstract's conclusion, not its body — do NOT enumerate counts, gene lists, or per-step results.",
        ),
    conclusions: z
        .string()
        .describe(
            "The PRIMARY interpretive section — the 'so what' — as connected prose (3-5 paragraphs). " +
                "What the run establishes and what is novel vs confirmatory; what is actionable translationally (therapeutic-target candidates, " +
                "biomarker candidates, safety signals, resistance mechanisms); how findings connect into a biological story; where computational " +
                "predictions agree or disagree with clinical evidence; and an honest assessment of the translational distance.",
        ),
    findings: z
        .array(SynthesizedFindingSchema)
        .describe(
            "SELECTIVE — only novel, contradicted, high-impact, or unexpected results that warrant individual attention. " +
                "NOT a per-step catalog. Target 3-7 for a typical run.",
        ),
    themes: z
        .array(BiologicalThemeSchema)
        .describe("Cross-step biological themes. Target 2-4. Return fewer (or zero) rather than forcing findings that do not converge."),
    limitations: z
        .array(z.string())
        .describe(
            "Concrete methodological and translational caveats — not generic disclaimers. " + "Each names what it affects and why it matters. Target 3-6.",
        ),
    keyReferences: z
        .array(KeyReferenceSchema)
        .describe(
            "The 5-10 most important papers across all findings. Prioritize those that directly validate, contradict, or extend the findings — do not pad with background citations.",
        ),
});

export type RunSynthesis = z.infer<typeof RunSynthesisSchema>;
export type SynthesizedFinding = z.infer<typeof SynthesizedFindingSchema>;
export type BiologicalTheme = z.infer<typeof BiologicalThemeSchema>;
export type LiteratureReference = z.infer<typeof LiteratureReferenceSchema>;
export type KeyReference = z.infer<typeof KeyReferenceSchema>;
