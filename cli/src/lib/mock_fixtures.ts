// MOCK fixtures for the design-system stream blocks and the sidebar's CONTEXT/RUNS
// slots. EVERYTHING here is sample data — NOT produced by the live engine, NOT
// persisted, NOT queried from SQLite, and NOT wired into the conversation store or
// event bus. It exists only so every design-system state can be rendered faithfully
// (see the design gallery). Swapping these for real engine output later touches only
// this module; the block components that consume it stay unchanged.
//
// Ids are literal `mock-*` sentinels (not `randomUUIDv7()`) precisely so a reader
// can tell at a glance that a value is fixture data, never a real row.

import type { TextPart, ThinkingPart, ToolCallPart, FileEditPart, PlanCardPart, RunCardPart } from "../types/session.ts";

/** A run step's lifecycle state. */
export type StepState = "done" | "running" | "queued";

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

/** MOCK: context-window accounting for the sidebar CONTEXT slot. */
export type ContextUsage = {
    /** Tokens consumed so far. */
    tokens: number;
    /** Percent of the context window used (0–100). */
    percent: number;
    /** Spend in USD. */
    costUsd: number;
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
        { id: "mock-step-14", label: "queued", state: "queued" },
    ],
};

/** MOCK sample: the run rows shown in the sidebar RUNS slot. */
export const mockRuns: Run[] = [{ id: "mock-run-done", name: "bulk-transcriptomics", tag: "T1S1", status: "done", done: 8, total: 8, steps: [] }, mockRun];

/** MOCK sample: the context accounting shown in the sidebar CONTEXT slot. */
export const mockContext: ContextUsage = {
    tokens: 12100,
    percent: 6,
    costUsd: 0.04,
};
