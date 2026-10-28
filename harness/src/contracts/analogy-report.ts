/**
 * Analogy Report — produced by the `generateAnalogyReport` tool. Single
 * source of truth for the JSON envelope returned to the conversation
 * agent. Both Cortex and the frontend import from this module.
 *
 * Coverage discipline: every analogy carries a
 * `coverage` discriminator. Only the extraction phase is allowed to throw;
 * search-phase failures surface via `coverage: "search_failed" |
 * "queried_no_data" | "not_loaded"`.
 */

import { z } from "zod";

export const AnalogyCoverageSchema = z.enum(["available", "queried_no_data", "search_failed", "not_loaded"]);
export type AnalogyCoverage = z.infer<typeof AnalogyCoverageSchema>;

/** One analogy of a report, with the cited solutions of its target domain. */
export const AnalogySchema = z.object({
    targetDomain: z.string(),
    analogyTitle: z.string(),
    objectMappings: z.array(
        z.object({
            source: z.string(),
            target: z.string(),
            rationale: z.string(),
        }),
    ),
    sharedRelations: z.string(),
    coverage: AnalogyCoverageSchema,
    solutions: z.array(
        z.object({
            title: z.string(),
            sourceDomain: z.string(),
            description: z.string().describe("Two or three sentences: the technical essentials of the method."),
            keyConcepts: z.array(z.string()),
            relevance: z.string().describe("How the method transfers back to the source problem."),
            sources: z.array(z.object({ url: z.url(), title: z.string().describe("The exact title as the search result gives it.") })),
            githubRepos: z.array(
                z.object({
                    url: z.url(),
                    description: z.string().optional(),
                }),
            ),
        }),
    ),
});

/** The extraction of the problem: what the analogies map from. */
export const AnalogyProblemSchema = z.object({
    problemSummary: z.string(),
    problemObjects: z.array(z.object({ name: z.string(), role: z.string() })),
    problemRelations: z.array(z.string()),
    keyTerms: z.array(z.string()),
});

export const AnalogyReportSchema = z.object({
    schemaVersion: z.literal("1"),
    ...AnalogyProblemSchema.shape,
    analogies: z.array(AnalogySchema),
});

export const AnalogyReportErrorSchema = z.object({
    schemaVersion: z.literal("1"),
    error: z.object({
        kind: z.enum(["extraction-failed"]),
        message: z.string(),
    }),
});

export const AnalogicalReasonerOutputSchema = z.union([AnalogyReportSchema, AnalogyReportErrorSchema]);

export type Analogy = z.infer<typeof AnalogySchema>;
export type AnalogyProblem = z.infer<typeof AnalogyProblemSchema>;
export type AnalogyReport = z.infer<typeof AnalogyReportSchema>;
export type AnalogyReportError = z.infer<typeof AnalogyReportErrorSchema>;
export type AnalogicalReasonerOutput = z.infer<typeof AnalogicalReasonerOutputSchema>;
