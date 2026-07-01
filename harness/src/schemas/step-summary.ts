/**
 * Step summary schema — plain markdown.
 *
 * Each sandbox step produces a free-form markdown summary at the end of its
 * execution. The schema intentionally carries no structured fields — the
 * markdown body is the single source of truth, rendered verbatim by the UI
 * and embedded verbatim into the vector search index with `type: "summary"`.
 *
 * Literature grounding is handled separately by the run synthesis step
 * (see run-synthesis.ts).
 */

import { z } from "zod";

export const StepSummarySchema = z.object({
    /** Step ID this summary belongs to. */
    stepId: z.string(),
    /** Agent that produced this summary. */
    agentId: z.string(),
    /** Free-form markdown body. Rendered directly by the UI. */
    markdown: z.string(),
});
export type StepSummary = z.infer<typeof StepSummarySchema>;
