/**
 * Step summary schema — plain markdown.
 *
 * Each sandbox step produces a free-form markdown summary at the end of its
 * execution. The markdown body is the single source of truth, rendered verbatim
 * by the UI and embedded verbatim into the vector search index with
 * `type: "summary"`. The one structured field is `methods`, which the host
 * builds, and the markdown carries its rendered block.
 *
 * Literature grounding is handled separately by the run synthesis step
 * (see run-synthesis.ts).
 */

import { z } from "zod";

import { StepMethodsSchema } from "../contracts/schemas/chat-parts.js";

export const StepSummarySchema = z.object({
    /** Step ID this summary belongs to. */
    stepId: z.string(),
    /** Agent that produced this summary. */
    agentId: z.string(),
    /** Free-form markdown body. Rendered directly by the UI. Ends with the methods block when `methods` is present. */
    markdown: z.string(),
    /**
     * The methods and the sources of the step, as the host builds them from the grounding and the decision
     * records. Absent for a step with no grounding and no record, and in a checkpoint written before the field.
     */
    methods: StepMethodsSchema.optional(),
});
export type StepSummary = z.infer<typeof StepSummarySchema>;
