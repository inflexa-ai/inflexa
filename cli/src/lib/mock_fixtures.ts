// MOCK fixtures for the design-system stream blocks shown in the design gallery.
// EVERYTHING here is sample data — NOT produced by the live engine, NOT persisted,
// NOT queried from SQLite, and NOT wired into the conversation store or event bus.
// It exists only so every design-system state can be rendered faithfully (see the
// design gallery). Swapping these for real engine output later touches only this
// module; the block components that consume it stay unchanged.
//
// Ids are literal `mock-*` sentinels (not `randomUUIDv7()`) precisely so a reader
// can tell at a glance that a value is fixture data, never a real row.

import type { CortexRunRow, DataProfileStatus, StepExecutionRow } from "@inflexa-ai/harness";

import type { TextPart, ThinkingPart, ToolCallPart, FileEditPart, PlanCardPart, RunCardPart } from "../types/session.ts";

/** A run step's lifecycle state (mirrors `RunStepView.state`). */
export type StepState = "done" | "running" | "failed" | "queued";

/** MOCK: one step within a run. */
export type RunStep = {
    id: string;
    /** Human label shown in the step list. */
    label: string;
    state: StepState;
};

/** A run's lifecycle state. */
export type RunStatus = "running" | "done" | "error";

/** MOCK: a long-running task with ordered steps and progress. */
export type Run = {
    id: string;
    /** Run name, e.g. `drug-repurposing`. */
    name: string;
    /** Short run tag, e.g. `T5S1`. */
    tag: string;
    status: RunStatus;
    steps: RunStep[];
    /** Completed step count (numerator of the progress bar). */
    done: number;
    /** Total step count (denominator of the progress bar). */
    total: number;
};

/** MOCK sample: a user text turn. */
export const mockUserText: TextPart = {
    id: "mock-text-user",
    sessionId: "mock-session",
    messageId: "mock-msg-user",
    type: "text",
    text: "what's the schema for analyses?",
    createdAt: 0,
};

/** MOCK sample: an assistant text turn. */
export const mockAssistantText: TextPart = {
    id: "mock-text-assistant",
    sessionId: "mock-session",
    messageId: "mock-msg-assistant",
    type: "text",
    text: "Each analysis row carries a `slug`, an `anchor_uuid`, and a goals blob.",
    createdAt: 0,
};

/** MOCK sample: a reasoning block. */
export const mockThinking: ThinkingPart = {
    id: "mock-thinking",
    sessionId: "mock-session",
    messageId: "mock-msg-assistant",
    type: "thinking",
    text: "The unique constraint should be (anchor_uuid, slug), not slug alone — two anchors can reuse a name without colliding.",
    durationMs: 8000,
    createdAt: 0,
};

/** MOCK sample: a tool call and its result. */
export const mockToolCall: ToolCallPart = {
    id: "mock-tool-call",
    sessionId: "mock-session",
    messageId: "mock-msg-assistant",
    type: "tool-call",
    name: "read_file",
    target: "src/db/types.ts :55-105",
    result: "export interface Anchor {\n  uuid: AnchorId\n  cached_path: string\n}",
    filetype: "ts",
    status: "ok",
    createdAt: 0,
};

/** MOCK sample: a file edit (unified diff). */
export const mockFileEdit: FileEditPart = {
    id: "mock-file-edit",
    sessionId: "mock-session",
    messageId: "mock-msg-assistant",
    type: "file-edit",
    path: "migrations/004_slug.sql",
    diff: [
        "--- a/migrations/004_slug.sql",
        "+++ b/migrations/004_slug.sql",
        "@@ -1,3 +1,4 @@",
        " CREATE TABLE analyses (",
        "-  slug TEXT",
        "+  slug TEXT NOT NULL,",
        "+  UNIQUE(anchor_uuid, slug)",
        " )",
    ].join("\n"),
    added: 2,
    removed: 1,
    createdAt: 0,
};

/** MOCK sample: a drafted plan card (as the harness emit adapter would mint it). */
export const mockPlanCard: PlanCardPart = {
    id: "mock-plan-card",
    type: "plan-card",
    planId: "plan-8f21",
    title: "Differential expression across conditions",
    steps: [
        { id: "s1", name: "QC & normalize counts", agent: "rna-preprocess" },
        { id: "s2", name: "Fit DE model", agent: "deseq2" },
        { id: "s3", name: "Pathway enrichment on DE genes", agent: "pathway" },
    ],
};

/** MOCK sample: a launched run card (identity + step count; no live status field, per the contract). */
export const mockRunCard: RunCardPart = {
    id: "mock-run-card",
    type: "run-card",
    runId: "run-3c07",
    title: "Differential expression across conditions",
    stepCount: 3,
};

/** MOCK sample: a live run with a mix of step states. */
export const mockRun: Run = {
    id: "mock-run",
    name: "drug-repurposing",
    tag: "T5S1",
    status: "running",
    done: 13,
    total: 20,
    steps: [
        { id: "mock-step-12", label: "rank consensus", state: "done" },
        { id: "mock-step-13", label: "build report", state: "running" },
        { id: "mock-step-14", label: "score targets", state: "failed" },
        { id: "mock-step-15", label: "queued", state: "queued" },
    ],
};

/** Sample age helper: an ISO timestamp `ms` in the past, so gallery exhibits show fresh relative ages. */
function ago(ms: number): string {
    return new Date(Date.now() - ms).toISOString();
}

/** MOCK sample: the harness run ledger for the RUNS details view (newest-first, mixed statuses). */
export const mockCortexRuns: CortexRunRow[] = [
    {
        runId: "mock-run-9a3f4c21",
        analysisId: "mock-analysis",
        threadId: null,
        workflowName: "executeAnalysis",
        status: "running",
        startedAt: ago(4 * 60_000),
        completedAt: null,
        error: null,
        parts: null,
        mandateJti: null,
        mandateExpiresAt: null,
        planId: "mock-plan-8f21",
        attemptCount: 0,
    },
    {
        runId: "mock-run-71bd0e55",
        analysisId: "mock-analysis",
        threadId: null,
        workflowName: "executeAnalysis",
        status: "completed",
        startedAt: ago(3 * 3_600_000),
        completedAt: ago(2 * 3_600_000),
        error: null,
        parts: null,
        mandateJti: null,
        mandateExpiresAt: null,
        planId: "mock-plan-6b0c",
        attemptCount: 0,
    },
    {
        runId: "mock-run-2c07af90",
        analysisId: "mock-analysis",
        threadId: null,
        workflowName: "executeAnalysis",
        status: "failed",
        startedAt: ago(2 * 86_400_000),
        completedAt: ago(2 * 86_400_000 - 5 * 60_000),
        error: "step_failed",
        parts: null,
        mandateJti: null,
        mandateExpiresAt: null,
        planId: null,
        attemptCount: 1,
    },
];

/**
 * MOCK sample: a completed data-profile status row. The gallery drives the DATA PROFILE details
 * exhibit through the REAL `profileDetailLines` over this fixture, so what it shows is exactly what a
 * loaded profile snapshot composes — no hand-kept line list to drift from the composer.
 */
export const mockDataProfile: DataProfileStatus = {
    status: "completed",
    error: null,
    startedAt: ago(5 * 60_000),
    completedAt: ago(4 * 60_000),
    result: {
        summary: "12 samples across 2 conditions; counts pass QC with no dropped libraries.",
        files: [
            { path: "data/counts.tsv", description: "gene-by-sample raw counts" },
            { path: "data/meta.csv", description: "sample metadata (condition, batch)" },
        ],
        inputFileIds: ["mock-input-counts", "mock-input-meta"],
        profiledAt: ago(4 * 60_000),
    },
    seedInputFileIds: ["mock-input-counts", "mock-input-meta"],
};

/** MOCK sample: the newest run's step ledger — one of each state the RUNS view renders (incl. a failure). */
export const mockRunSteps: StepExecutionRow[] = [
    {
        runId: "mock-run-9a3f4c21",
        stepId: "qc-normalize",
        analysisId: "mock-analysis",
        wave: 0,
        agentId: "rna-preprocess",
        status: "completed",
        startedAt: ago(4 * 60_000),
        completedAt: ago(3 * 60_000),
        durationMs: 60_000,
        error: null,
        attempts: 1,
        lastErrorClass: null,
        finishReason: "stop",
        hitMaxSteps: false,
        blockedReason: null,
        sandboxRef: null,
        execId: null,
        childWorkflowId: null,
    },
    {
        runId: "mock-run-9a3f4c21",
        stepId: "fit-de-model",
        analysisId: "mock-analysis",
        wave: 1,
        agentId: "deseq2",
        status: "running",
        startedAt: ago(2 * 60_000),
        completedAt: null,
        durationMs: null,
        error: null,
        attempts: 1,
        lastErrorClass: null,
        finishReason: null,
        hitMaxSteps: false,
        blockedReason: null,
        sandboxRef: null,
        execId: null,
        childWorkflowId: null,
    },
    {
        runId: "mock-run-9a3f4c21",
        stepId: "pathway-enrichment",
        analysisId: "mock-analysis",
        wave: 1,
        agentId: "pathway",
        status: "failed",
        startedAt: ago(90_000),
        completedAt: ago(60_000),
        durationMs: 30_000,
        error: "sandbox exited non-zero (exit 1)",
        attempts: 2,
        lastErrorClass: "runtime",
        finishReason: null,
        hitMaxSteps: false,
        blockedReason: null,
        sandboxRef: null,
        execId: null,
        childWorkflowId: null,
    },
    {
        runId: "mock-run-9a3f4c21",
        stepId: "synthesis",
        analysisId: "mock-analysis",
        wave: 2,
        agentId: "synthesis",
        status: "pending",
        startedAt: null,
        completedAt: null,
        durationMs: null,
        error: null,
        attempts: 1,
        lastErrorClass: null,
        finishReason: null,
        hitMaxSteps: false,
        blockedReason: null,
        sandboxRef: null,
        execId: null,
        childWorkflowId: null,
    },
];
