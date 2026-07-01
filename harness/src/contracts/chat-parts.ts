/**
 * Cortex chat data parts — custom parts emitted via writer.write() / writer.custom()
 * that flow through the chat stream and are rendered by the frontend.
 *
 * 15 part types across four categories:
 *   Presentation:    data-presentation (agent-synthesized content),
 *                    data-plan (plan by id), data-file-reference (files by path)
 *   Run lifecycle:   run-started, dag-state, run-completed, run-failed, run-synthesis,
 *                    synthesis-progress
 *   Per-step live:   step-activity, step-file-tree
 *   Per-step final:  step-output, step-summary
 */

// ── Presentation (agent-synthesized content) ────────────────────────

export interface PlanStep {
    id: string;
    name: string;
    agent: string;
    question: string;
    depends_on: string[];
    resources?: { cpu: number; memoryGb: number };
    maxSteps: number;
}

export type PresentationContent =
    | { kind: "echart"; spec: Record<string, unknown> }
    | { kind: "markdown"; body: string }
    | { kind: "code"; code: string; language: string }
    | { kind: "svg"; markup: string }
    | { kind: "table"; headers: string[]; rows: string[][]; caption?: string };

export interface PresentationPart {
    type: "data-presentation";
    id: string;
    title?: string;
    content: PresentationContent;
}

// ── Plan reference (DB-backed) ──────────────────────────────────────

export interface PlanPart {
    type: "data-plan";
    id: string;
    planId: string;
    title?: string;
    steps?: PlanStep[];
    analytical_narrative?: string;
    omicsType?: string;
    omicsSubtype?: string;
}

// ── Run card (chat-rendered, reconstructed on read) ─────────────────

export interface RunCardPart {
    type: "data-run-card";
    id: string;
    runId: string;
    planId: string;
    title: string;
    stepCount: number;
}

// ── File reference (artifact-store-backed, resolved at render time) ──────────

export interface FileReferenceEntry {
    path: string;
    runId?: string;
    caption?: string;
}

export interface FileReferencePart {
    type: "data-file-reference";
    id: string;
    title?: string;
    files: FileReferenceEntry[];
}

// ── Run Started ─────────────────────────────────────────────────────

export interface RunStartedPart {
    type: "data-run-started";
    runId: string;
    planSummary: string;
    stepCount: number;
}

// ── DAG State (reconciliating) ──────────────────────────────────────

export type StepStatus = "pending" | "running" | "completed" | "failed";

export interface DagStepState {
    id: string;
    name: string;
    agent: string;
    status: StepStatus;
    /**
     * Topological depth from DAG sources (level 0 = no deps; level N = max(level(deps)) + 1).
     * Layout-only — does NOT gate execution. Two steps at the same level may run or
     * complete in any order.
     */
    level: number;
    dependsOn: string[];
    /** Duration in ms (set on completion). */
    durationMs?: number;
    /** Artifact count (set on completion). */
    artifactCount?: number;
    /** Brief summary (set on completion). */
    summary?: string;
    /** Error message (set on failure). */
    error?: string;
}

export interface DagStatePart {
    type: "data-dag-state";
    /** Stable ID for reconciliation — same across all updates for a run. */
    id: string;
    runId: string;
    steps: DagStepState[];
}

// ── Step Activity (reconciliating per-step) ─────────────────────────

export type StepPhase =
    | "sandbox-init"
    | "executing"
    | "generating-metadata"
    | "generating-summary"
    | "indexing"
    /** Step bytes are uploading to the artifact store inline (per-step sync). */
    | "persisting"
    | "complete"
    | "failed"
    /** Step is being retried after a classified-transient failure. */
    | "retrying"
    /** Non-fatal warning emitted during step execution (e.g., maxSteps hit). */
    | "warning";

export interface StepActivityPart {
    type: "data-step-activity";
    /** Stable ID for reconciliation — unique per step within a run. */
    id: string;
    runId: string;
    stepId: string;
    /** Current execution phase. */
    phase: StepPhase;
    /** Human-readable activity description (e.g., "Running DESeq2 analysis"). */
    activity: string;
}

// ── Step File Tree (reconciliating per-step) ────────────────────────

export interface FileTreeEntry {
    path: string;
    size?: number;
    type: "file" | "directory";
}

export interface StepFileTreePart {
    type: "data-step-file-tree";
    /** Stable ID for reconciliation — unique per step within a run. */
    id: string;
    runId: string;
    stepId: string;
    /** Current file tree snapshot. May be empty if sandbox hasn't written to disk yet. */
    files: FileTreeEntry[];
}

// ── Step Output (persistent, once per step) ─────────────────────────

export interface StepOutputFile {
    path: string;
    size: number;
    /** File category for grouping/icons. */
    fileType: "script" | "output" | "figure" | "log" | "notebook" | "summary";
    /** LLM-generated description of the file contents. */
    description: string;
}

export interface StepOutputPart {
    type: "data-step-output";
    id: string;
    runId: string;
    stepId: string;
    agentId: string;
    files: StepOutputFile[];
    artifactCount: number;
    durationMs: number;
    /** Agent-stream finish reason ("stop", "tool-calls", "length", ...). Absent on rescued-from-failure outputs. */
    finishReason?: string;
    /** True when the agent exhausted its maxSteps turn budget. */
    hitMaxSteps?: boolean;
}

// ── Step Summary (persistent, once per step) ────────────────────────

/** Step summary — free-form markdown body, rendered verbatim by the UI. */
export interface StepSummaryPart {
    type: "data-step-summary";
    id: string;
    runId: string;
    stepId: string;
    agentId: string;
    /** Free-form markdown body. Render with a markdown renderer. */
    markdown: string;
}

// ── Step Blocked (persistent, once per step) ────────────────────────

/**
 * Emitted when a step agent declares it cannot fulfil its step via
 * `report_blocker` (see the harness-sandbox-agents spec). A blocked step has no deliverables; the
 * reason surfaces in the run side panel.
 */
export interface StepBlockedPart {
    type: "data-step-blocked";
    id: string;
    runId: string;
    stepId: string;
    agentId: string;
    /** Agent-declared reason the step could not be fulfilled. */
    reason: string;
}

// ── Run Completed ───────────────────────────────────────────────────

export interface RunCompletedFinding {
    title: string;
    confidence: "high" | "medium" | "low";
}

export interface RunCompletedPart {
    type: "data-run-completed";
    runId: string;
    status: "completed" | "partial";
    completedSteps: number;
    totalSteps: number;
    artifactCount: number;
    /** Top findings for quick display. */
    findings: RunCompletedFinding[];
    /**
     * Optional human-readable explanation — present when `status === "partial"`
     * to explain why (e.g., synthesis failed but step summaries are available).
     */
    note?: string;
}

// ── Run Synthesis (persistent, once per run) ────────────────────────

export interface SynthesizedFinding {
    stepId: string;
    title: string;
    description: string;
    confidence: "high" | "medium" | "low";
    noveltyStatus: "novel" | "confirmed" | "partially_confirmed" | "contradicted" | "expected";
    literatureInterpretation: string;
}

export interface BiologicalTheme {
    name: string;
    findings: { stepId: string; title: string }[];
    narrative: string;
}

export interface RunSynthesisPart {
    type: "data-run-synthesis";
    id: string;
    runId: string;
    overview: string;
    conclusions?: string;
    findings: SynthesizedFinding[];
    themes: BiologicalTheme[];
    limitations?: string[];
    keyReferences: { pmid: string; citation: string; description: string }[];
}

// ── Synthesis Progress (reconciling per-run) ────────────────────────

export type SynthesisPhase =
    | "starting"
    | "researching"
    | "drafting"
    | "validating"
    | "refining"
    | "indexing"
    | "persisting"
    | "complete"
    /**
     * Synthesizer chose to skip (e.g., technical-only run, summaries with no
     * findings worth surfacing). Distinct from `failed` — this is an
     * intentional outcome, not a breakage.
     */
    | "skipped"
    | "failed";

export interface SynthesisProgressPart {
    type: "data-synthesis-progress";
    /** Stable ID for reconciliation — `synthesis-progress-{runId}`. */
    id: string;
    runId: string;
    phase: SynthesisPhase;
    /** Human-readable activity description. */
    activity: string;
    /** Number of literature-reviewer delegations started so far. */
    delegationCount?: number;
    /** Number of times the synthesizer's submit_synthesis call was rejected. */
    validationAttempts?: number;
    /** Agent-provided reason — set when phase === "skipped". */
    reason?: string;
    /** Error message — set when phase === "failed". */
    error?: string;
}

// ── Run Failed ──────────────────────────────────────────────────────

export interface RunFailedPart {
    type: "data-run-failed";
    runId: string;
    /** Scrubbed error message (no internal details). */
    error: string;
    /** Machine-readable failure reason (e.g., "budget_exceeded"). */
    reason?: string;
}

// ── Preview (iterative report) ─────────────────────────────────────

export interface PreviewPart {
    type: "data-preview";
    /** Unique per emission (UUID). */
    id: string;
    /** Groups all versions of the same preview. */
    previewId: string;
    /** Version number (1, 2, 3, ...). */
    version: number;
    /** Report title. */
    title: string;
    /** Version-relative path (e.g., "v1/index.html"). */
    previewPath: string;
    /** Report format. */
    format: "html" | "pdf";
}

// ── Preview Failed (iterative report) ──────────────────────────────

export interface DataPreviewFailedPart {
    type: "data-preview-failed";
    /** Unique per emission (UUID). */
    id: string;
    /** Groups all versions of the same preview. */
    previewId: string;
    /** Attempted version number that failed. */
    version: number;
    /** Human-readable failure reason. */
    reason: string;
    /** Optional taxonomy of failure kinds. */
    errorKind?: "render" | "submit" | "build" | "timeout" | "internal";
}

// ── Union ───────────────────────────────────────────────────────────

export type CortexChatPart =
    | PresentationPart
    | PlanPart
    | RunCardPart
    | FileReferencePart
    | RunStartedPart
    | DagStatePart
    | StepActivityPart
    | StepFileTreePart
    | StepOutputPart
    | StepSummaryPart
    | StepBlockedPart
    | RunSynthesisPart
    | SynthesisProgressPart
    | RunCompletedPart
    | RunFailedPart
    | PreviewPart
    | DataPreviewFailedPart;
