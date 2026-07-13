/**
 * Zod schemas for Cortex chat data parts — validation at boundaries.
 */

import { z } from "zod";

// ── Presentation ────────────────────────────────────────────────────

export const PlanStepSchema = z.object({
    id: z.string(),
    name: z.string(),
    agent: z.string(),
    question: z.string(),
    depends_on: z.array(z.string()),
    resources: z.object({ cpu: z.number(), memoryGb: z.number() }).optional(),
    maxSteps: z.number(),
});

export const PresentationContentSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("echart"),
        spec: z.record(z.string(), z.unknown()),
        // Analysis-rooted CSV path the host resolves to `dataset.source` at render time; optional
        // because a self-contained spec may embed its own data.
        dataPath: z.string().optional(),
    }),
    z.object({
        kind: z.literal("markdown"),
        body: z.string(),
    }),
    z.object({
        kind: z.literal("code"),
        code: z.string(),
        language: z.string(),
    }),
    z.object({
        kind: z.literal("svg"),
        markup: z.string(),
    }),
    z.object({
        kind: z.literal("table"),
        headers: z.array(z.string()),
        rows: z.array(z.array(z.string())),
        caption: z.string().optional(),
    }),
]);

export const PresentationPartSchema = z.object({
    type: z.literal("data-presentation"),
    id: z.string(),
    title: z.string().optional(),
    content: PresentationContentSchema,
});

// ── Plan reference ──────────────────────────────────────────────────

export const PlanPartSchema = z.object({
    type: z.literal("data-plan"),
    id: z.string(),
    planId: z.string().regex(/^pln-[a-f0-9]{8}$/),
    title: z.string().optional(),
    steps: z.array(PlanStepSchema).optional(),
    analytical_narrative: z.string().optional(),
    omicsType: z.string().optional(),
    omicsSubtype: z.string().optional(),
});

// ── Run card ────────────────────────────────────────────────────────

export const RunCardPartSchema = z.object({
    type: z.literal("data-run-card"),
    id: z.string(),
    runId: z.string(),
    planId: z.string(),
    title: z.string(),
    stepCount: z.number(),
});

// ── File reference ──────────────────────────────────────────────────

export const FileReferenceEntrySchema = z.object({
    path: z.string().min(1),
    runId: z.string().optional(),
    caption: z.string().optional(),
});

export const FileReferencePartSchema = z.object({
    type: z.literal("data-file-reference"),
    id: z.string(),
    title: z.string().optional(),
    files: z.array(FileReferenceEntrySchema).min(1).max(10),
});

// ── Run Started ─────────────────────────────────────────────────────

export const RunStartedPartSchema = z.object({
    type: z.literal("data-run-started"),
    runId: z.string(),
    planSummary: z.string(),
    stepCount: z.number(),
});

// ── DAG State ───────────────────────────────────────────────────────

export const StepStatusSchema = z.enum(["pending", "running", "completed", "failed"]);

export const DagStepStateSchema = z
    .object({
        id: z.string(),
        name: z.string(),
        agent: z.string(),
        status: StepStatusSchema,
        level: z.number().int().nonnegative(),
        dependsOn: z.array(z.string()),
        durationMs: z.number().optional(),
        artifactCount: z.number().optional(),
        summary: z.string().optional(),
        error: z.string().optional(),
    })
    .strict();

export const DagStatePartSchema = z
    .object({
        type: z.literal("data-dag-state"),
        id: z.string(),
        runId: z.string(),
        steps: z.array(DagStepStateSchema),
    })
    .strict();

// ── Step Activity ───────────────────────────────────────────────────

export const StepPhaseSchema = z.enum([
    "sandbox-init",
    "executing",
    "generating-metadata",
    "generating-summary",
    "indexing",
    "persisting",
    "complete",
    "failed",
    "retrying",
    "warning",
]);

export const StepActivityPartSchema = z.object({
    type: z.literal("data-step-activity"),
    id: z.string(),
    runId: z.string(),
    stepId: z.string(),
    phase: StepPhaseSchema,
    activity: z.string(),
});

// ── Step File Tree ──────────────────────────────────────────────────

export const FileTreeEntrySchema = z.object({
    path: z.string(),
    size: z.number().optional(),
    type: z.enum(["file", "directory"]),
});

export const StepFileTreePartSchema = z.object({
    type: z.literal("data-step-file-tree"),
    id: z.string(),
    runId: z.string(),
    stepId: z.string(),
    files: z.array(FileTreeEntrySchema),
});

// ── Step Output ─────────────────────────────────────────────────────

export const StepOutputFileSchema = z.object({
    path: z.string(),
    size: z.number(),
    fileType: z.enum(["script", "output", "figure", "log", "notebook", "summary"]),
    description: z.string(),
});

export const StepOutputPartSchema = z.object({
    type: z.literal("data-step-output"),
    id: z.string(),
    runId: z.string(),
    stepId: z.string(),
    agentId: z.string(),
    files: z.array(StepOutputFileSchema),
    artifactCount: z.number(),
    durationMs: z.number(),
    finishReason: z.string().optional(),
    hitMaxSteps: z.boolean().optional(),
});

// ── Step Summary ────────────────────────────────────────────────────

export const StepSummaryPartSchema = z.object({
    type: z.literal("data-step-summary"),
    id: z.string(),
    runId: z.string(),
    stepId: z.string(),
    agentId: z.string(),
    markdown: z.string(),
});

export const StepBlockedPartSchema = z.object({
    type: z.literal("data-step-blocked"),
    id: z.string(),
    runId: z.string(),
    stepId: z.string(),
    agentId: z.string(),
    reason: z.string(),
});

// ── Run Completed ───────────────────────────────────────────────────

export const RunCompletedFindingSchema = z.object({
    title: z.string(),
    confidence: z.enum(["high", "medium", "low"]),
});

export const RunCompletedPartSchema = z.object({
    type: z.literal("data-run-completed"),
    runId: z.string(),
    status: z.enum(["completed", "partial"]),
    completedSteps: z.number(),
    totalSteps: z.number(),
    artifactCount: z.number(),
    findings: z.array(RunCompletedFindingSchema),
    note: z.string().optional(),
});

// ── Run Synthesis ──────────────────────────────────────────────────

export const SynthesizedFindingSchema = z.object({
    stepId: z.string(),
    title: z.string(),
    description: z.string(),
    confidence: z.enum(["high", "medium", "low"]),
    noveltyStatus: z.enum(["novel", "confirmed", "partially_confirmed", "contradicted", "expected"]),
    literatureInterpretation: z.string(),
});

export const BiologicalThemeSchema = z.object({
    name: z.string(),
    findings: z.array(z.object({ stepId: z.string(), title: z.string() })),
    narrative: z.string(),
});

export const RunSynthesisPartSchema = z.object({
    type: z.literal("data-run-synthesis"),
    id: z.string(),
    runId: z.string(),
    overview: z.string(),
    conclusions: z.string().optional(),
    findings: z.array(SynthesizedFindingSchema),
    themes: z.array(BiologicalThemeSchema),
    limitations: z.array(z.string()).optional(),
    keyReferences: z.array(
        z.object({
            pmid: z.string(),
            citation: z.string(),
            description: z.string(),
        }),
    ),
});

// ── Synthesis Progress ─────────────────────────────────────────────

export const SynthesisPhaseSchema = z.enum([
    "starting",
    "researching",
    "drafting",
    "validating",
    "refining",
    "indexing",
    "persisting",
    "complete",
    "skipped",
    "failed",
]);

export const SynthesisProgressPartSchema = z.object({
    type: z.literal("data-synthesis-progress"),
    id: z.string(),
    runId: z.string(),
    phase: SynthesisPhaseSchema,
    activity: z.string(),
    delegationCount: z.number().int().nonnegative().optional(),
    validationAttempts: z.number().int().nonnegative().optional(),
    reason: z.string().optional(),
    error: z.string().optional(),
});

// ── Run Failed ──────────────────────────────────────────────────────

export const RunFailedPartSchema = z.object({
    type: z.literal("data-run-failed"),
    runId: z.string(),
    error: z.string(),
    reason: z.string().optional(),
});

// ── Preview ────────────────────────────────────────────────────────

export const PreviewPartSchema = z.object({
    type: z.literal("data-report-preview"),
    id: z.string(),
    previewId: z.string(),
    version: z.number(),
    title: z.string(),
    previewPath: z.string(),
    format: z.enum(["html", "pdf"]),
});

// ── Preview Failed ─────────────────────────────────────────────────

export const DataPreviewFailedPartSchema = z.object({
    type: z.literal("data-report-preview-failed"),
    id: z.string(),
    previewId: z.string(),
    version: z.number(),
    reason: z.string(),
    errorKind: z.enum(["render", "submit", "build", "timeout", "internal"]).optional(),
});

// ── Union ───────────────────────────────────────────────────────────

export const CortexChatPartSchema = z.discriminatedUnion("type", [
    PresentationPartSchema,
    PlanPartSchema,
    RunCardPartSchema,
    FileReferencePartSchema,
    RunStartedPartSchema,
    DagStatePartSchema,
    StepActivityPartSchema,
    StepFileTreePartSchema,
    StepOutputPartSchema,
    StepSummaryPartSchema,
    StepBlockedPartSchema,
    RunSynthesisPartSchema,
    SynthesisProgressPartSchema,
    RunCompletedPartSchema,
    RunFailedPartSchema,
    PreviewPartSchema,
    DataPreviewFailedPartSchema,
]);
