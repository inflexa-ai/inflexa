/**
 * Cortex execution state schemas.
 *
 * Defines Zod schemas for the cortex_* tables and their payloads.
 * These schemas are Cortex-internal — they never cross the service API boundary.
 */

import { z } from "zod";

// ── Table Row Types ──────────────────────────────────────────────────

export const AnalysisStateRowSchema = z.object({
    resourceId: z.string(),
    status: z.string(),
    context: z.string().nullable(),
    dataProfileStatus: z.enum(["pending", "running", "completed", "failed"]),
    dataProfileError: z.string().nullable(),
    dataProfileStartedAt: z.string().nullable(),
    dataProfileCompletedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
});
export type AnalysisStateRow = z.infer<typeof AnalysisStateRowSchema>;

export const ArtifactRole = z.enum(["input", "step_output"]);
export type ArtifactRole = z.infer<typeof ArtifactRole>;

export const ArtifactRowSchema = z.object({
    resourceId: z.string(),
    path: z.string(),
    artifactId: z.string().nullable(),
    fileId: z.string().nullable(),
    hash: z.string(),
    size: z.number(),
    role: ArtifactRole,
    sourceStep: z.string().nullable(),
    sourceRun: z.string().nullable(),
    createdAt: z.string(),
    unrecoverableAt: z.string().nullable(),
    fileType: z.string().nullable(),
});
export type ArtifactRow = z.infer<typeof ArtifactRowSchema>;

// ── Run & Step Execution Schemas ─────────────────────────────────────

export const RunStatus = z.enum(["running", "completed", "partial", "failed", "canceled", "suspended_insufficient_funds"]);
export type RunStatus = z.infer<typeof RunStatus>;

export const StepExecutionStatus = z.enum(["pending", "running", "completed", "failed", "skipped", "canceled", "blocked"]);
export type StepExecutionStatus = z.infer<typeof StepExecutionStatus>;

export const CortexRunRowSchema = z.object({
    runId: z.string(),
    analysisId: z.string(),
    threadId: z.string().nullable(),
    workflowName: z.string(),
    status: RunStatus,
    startedAt: z.string(),
    completedAt: z.string().nullable(),
    error: z.string().nullable(),
    parts: z.array(z.any()).nullable(),
    mandateJti: z.string().nullable(), // oss-core-managed-ok: run-mandate ledger (nullable; OSS leaves null)
    mandateExpiresAt: z.string().nullable(), // oss-core-managed-ok: run-mandate ledger (nullable; OSS leaves null)
    planId: z.string().nullable(),
});
export type CortexRunRow = z.infer<typeof CortexRunRowSchema>;

/**
 * Persistable sandbox handle — what the active-sandbox registry stores on
 * `cortex_step_executions.sandbox_ref`. Excludes the per-sandbox
 * `callbackSecret`, which lives only in the DBOS step-output cache (ADR
 * 0007). The harness reconstructs the full in-memory `SandboxRef` by
 * reading the secret from the cached `createSandbox` step output.
 */
export const PersistedSandboxRefSchema = z.object({
    sandboxId: z.string(),
    host: z.string(),
    port: z.number(),
    backend: z.enum(["docker", "k8s"]),
});
export type PersistedSandboxRef = z.infer<typeof PersistedSandboxRefSchema>;

export const StepExecutionRowSchema = z.object({
    runId: z.string(),
    stepId: z.string(),
    analysisId: z.string(),
    wave: z.number(),
    agentId: z.string(),
    status: StepExecutionStatus,
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    durationMs: z.number().nullable(),
    error: z.string().nullable(),
    /** 1-based count of attempts taken to execute this step (increments on retry). */
    attempts: z.number().default(1),
    /** Classified error class of the previous failed attempt (null on first attempt / success). */
    lastErrorClass: z.string().nullable(),
    /** Agent-stream finish reason of the final step ("stop", "tool-calls", "length", ...). */
    finishReason: z.string().nullable(),
    /** True when the agent exhausted its `maxSteps` turn budget. */
    hitMaxSteps: z.boolean().default(false),
    /** Agent-declared blocker reason (see the harness-sandbox-agents spec); null unless `status === "blocked"`. */
    blockedReason: z.string().nullable().default(null),
    /** Active-sandbox registry handle; null when no sandbox is live for this step. */
    sandboxRef: PersistedSandboxRefSchema.nullable().default(null),
    /** In-flight `${workflowId}:${stepId}:${functionId}`; null when no exec is in flight. */
    execId: z.string().nullable().default(null),
    /** DBOS child workflow id (`"${parentWorkflowId}-${N}"`); null on pre-DBOS rows. */
    childWorkflowId: z.string().nullable().default(null),
});
export type StepExecutionRow = z.infer<typeof StepExecutionRowSchema>;

// ── Plans ────────────────────────────────────────────────────────────

export const CortexPlanRowSchema = z.object({
    planId: z.string(),
    analysisId: z.string(),
    plan: z.record(z.string(), z.unknown()),
    parentPlanId: z.string().nullable(),
    createdAt: z.string(),
});
export type CortexPlanRow = z.infer<typeof CortexPlanRowSchema>;
