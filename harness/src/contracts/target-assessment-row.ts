/**
 * Zod schemas for the `cortex_target_assessments` row shape.
 *
 * Single source of truth for both Cortex (DB row mappers, HTTP routes) and
 * downstream consumers that need to validate the row shape at runtime.
 *
 * The HTTP API response types in `../api/types.ts` are TypeScript-only
 * interfaces tailored to the frontend render path; these Zod schemas describe
 * the full DB row including DBOS workflow tracking fields.
 */

import { z } from "zod";

export const TargetAssessmentStatusSchema = z.enum(["queued", "running", "completed", "failed", "deleted", "suspended_insufficient_funds"]);
export type TargetAssessmentStatus = z.infer<typeof TargetAssessmentStatusSchema>;

export const TargetAssessmentErrorSchema = z.object({
    kind: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
});
export type TargetAssessmentError = z.infer<typeof TargetAssessmentErrorSchema>;

export const TargetAssessmentListRowSchema = z.object({
    id: z.string().uuid(),
    organizationId: z.string(),
    targetId: z.string(),
    targetLabel: z.string(),
    goal: z.string().nullable(),
    status: TargetAssessmentStatusSchema,
    progress: z.string().nullable(),
    billingContextId: z.string(),
    error: TargetAssessmentErrorSchema.nullable(),
    requestedBy: z.string(),
    workflowRunId: z.string().nullable(),
    workflowId: z.string().nullable().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    completedAt: z.string().nullable(),
});
export type TargetAssessmentListRow = z.infer<typeof TargetAssessmentListRowSchema>;

export const TargetAssessmentRowSchema = TargetAssessmentListRowSchema.extend({
    dossier: z.record(z.string(), z.unknown()).nullable(),
});
export type TargetAssessmentRow = z.infer<typeof TargetAssessmentRowSchema>;
