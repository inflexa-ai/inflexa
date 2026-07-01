/**
 * Phase 0 — target resolution.
 *
 * The single step in the workflow allowed to throw. A hard resolution
 * failure aborts the assessment with `error.kind: "target-unresolved"`.
 *
 * The DBOS workflow body re-implements Phase 0 inline; this module is kept
 * for its schemas (input/output) so dependent modules continue to compile.
 */

import { TargetAssessmentInputSchema, ResolvedTargetSchema } from "../schemas.js";
import { resolveTarget } from "../../../tools/lib/identifier-resolver.js";

export const phase0InputSchema = TargetAssessmentInputSchema;
export const phase0OutputSchema = ResolvedTargetSchema;

export async function phase0Execute(inputData: { assessmentId: string; goal?: string | null; target: string }) {
    const resolved = await resolveTarget(inputData.target);
    return {
        assessmentId: inputData.assessmentId,
        goal: inputData.goal ?? null,
        ...resolved,
    };
}
