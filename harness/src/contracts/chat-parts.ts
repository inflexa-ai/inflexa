/**
 * Chat data parts — the `data-*` parts that a tool or a workflow emits, and that
 * a surface renders from the chat stream or the run stream.
 *
 * Categories:
 *   Presentation:    data-presentation (agent-synthesized content),
 *                    data-plan (plan by id), data-file-reference (files by path)
 *   Approval:        data-ask (a tool's pending user-approval prompt),
 *                    data-plan-approval (the record of an approved plan)
 *   Compaction:      data-compaction (a compaction of the conversation thread)
 *   Run lifecycle:   run-started, dag-state, run-completed, run-failed, run-synthesis,
 *                    synthesis-progress
 *   Per-step live:   step-activity, step-file-tree
 *   Activity history: activity-entry (run stream), subagent-activity (conversation)
 *   Per-step final:  step-output, step-summary, step-usage
 */

import type { ToolCallOutcome } from "./chat-events.js";
import type { TokenUsageRollup } from "./usage.js";

// ── Presentation (agent-synthesized content) ────────────────────────

export type PlanStep = {
    id: string;
    name: string;
    agent: string;
    question: string;
    depends_on: string[];
    resources?: { cpu: number; memoryGb: number; gpu?: { count: number } };
    maxSteps: number;
    track?: string;
    step_type?: string;
    acceptance_criteria?: string[];
    constraints?: string[];
    caveats?: string[];
};

export type PresentationContent =
    /** `dataPath` (optional): an analysis-rooted CSV artifact path the host loads and injects as the
     *  chart's `dataset.source` at render time — the data never rides through the context window. */
    | { kind: "echart"; spec: Record<string, unknown>; dataPath?: string }
    | { kind: "markdown"; body: string }
    | { kind: "code"; code: string; language: string }
    | { kind: "svg"; markup: string }
    | { kind: "table"; headers: string[]; rows: string[][]; caption?: string }
    /** A versioned AlphaFold DB model file, normalized by the harness from the URL the agent named
     *  (`contracts/structure-source.ts`). `version` is the model version that was shown — a host that
     *  substitutes a newer file after AlphaFold purges this one labels the substitution and never
     *  rewrites the card. The host fetches `url` directly; the coordinates never ride the wire. */
    | { kind: "structure"; format: "pdb" | "mmcif"; url: string; provider: "alphafold"; accession: string; version: number };

export type PresentationPart = {
    type: "data-presentation";
    id: string;
    title?: string;
    content: PresentationContent;
};

// ── Plan reference (DB-backed) ──────────────────────────────────────

export type PlanPart = {
    type: "data-plan";
    id: string;
    planId: string;
    /** The plan that this plan revised. Absent for a first plan. */
    parentPlanId?: string;
    title?: string;
    steps?: PlanStep[];
    analytical_narrative?: string;
    omicsType?: string;
    omicsSubtype?: string;
};

// ── Run card (chat-rendered, reconstructed on read) ─────────────────

export type RunCardPart = {
    type: "data-run-card";
    id: string;
    runId: string;
    planId: string;
    title: string;
    stepCount: number;
};

// ── Plan approval (conversation record) ─────────────────────────────

export type PlanApprovalPart = {
    type: "data-plan-approval";
    planId: string;
    /** The run that the approval started. */
    runId: string;
    /** ISO 8601. The instant of the approval, equal to the time of the `approve-plan` provenance event. */
    approvedAt: string;
};

// ── File reference (artifact-store-backed, resolved at render time) ──────────

export type FileReferenceEntry = {
    path: string;
    runId?: string;
    caption?: string;
};

export type FileReferencePart = {
    type: "data-file-reference";
    id: string;
    title?: string;
    files: FileReferenceEntry[];
};

// ── Ask (user approval, reconciling) ────────────────────────────────

/**
 * A tool's pending request for an explicit user decision. Re-emitted under the
 * same `id` when the ask reaches a terminal status, so reconciling readers fold
 * pending → outcome latest-wins.
 */
export type AskPart = {
    type: "data-ask";
    /** The ask's ledger uuidv7 id — what a surface passes back to `answer`. */
    id: string;
    /** Human-facing headline for the pending approval. */
    title: string;
    /** The exact command or operation being approved — what the user sees granted. */
    command: string;
    /** Optional additional detail a surface may render. */
    detail?: string;
    status: "pending" | "resolved" | "rejected" | "aborted" | "expired";
    /** The kind of the ledger reply. Only a `resolved` or `rejected` part carries it, and never the rejection feedback. */
    reply?: "once" | "always" | "reject";
};

// ── Run Started ─────────────────────────────────────────────────────

export type RunStartedPart = {
    type: "data-run-started";
    runId: string;
    planSummary: string;
    stepCount: number;
};

// ── DAG State (reconciliating) ──────────────────────────────────────

/** `"pending"` = waiting on dependencies; `"queued"` = dependencies satisfied,
 *  held until in-flight steps free machine-budget capacity; `"skipped"` =
 *  unreachable — an upstream dependency failed or blocked, so the step can
 *  never be dispatched. */
export type StepStatus = "pending" | "queued" | "running" | "completed" | "failed" | "skipped";

export type DagStepState = {
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
};

/** One step of the stored plan graph: the fields of {@link DagStepState} that the plan alone fixes. */
export type PlanGraphStep = Pick<DagStepState, "id" | "name" | "agent" | "dependsOn" | "level">;

export type DagStatePart = {
    type: "data-dag-state";
    /** Stable ID for reconciliation — same across all updates for a run. */
    id: string;
    runId: string;
    steps: DagStepState[];
};

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

export type StepActivityPart = {
    type: "data-step-activity";
    /** Stable ID for reconciliation — unique per step within a run. */
    id: string;
    runId: string;
    stepId: string;
    /** Current execution phase. */
    phase: StepPhase;
    /** Human-readable activity description (e.g., "Running DESeq2 analysis"). */
    activity: string;
    /** ISO 8601 time of the emission. Absent on a part that an older harness wrote. */
    at?: string;
};

/**
 * One activity emission of a step or a data profile, kept in the run stream with no reconciliation. The fold
 * delivers each entry in write order.
 */
export type ActivityEntryPart = {
    type: "data-activity-entry";
    /** Unique per emission within a stream. */
    id: string;
    runId: string;
    stepId: string;
    /** A `SynthesisPhase` for the entries of the synthesis step, a `StepPhase` for each other step. */
    phase: StepPhase | SynthesisPhase;
    activity: string;
    /** ISO 8601 time of the emission. */
    at: string;
};

// ── Step File Tree (reconciliating per-step) ────────────────────────

export type FileTreeEntry = {
    path: string;
    size?: number;
    type: "file" | "directory";
};

export type StepFileTreePart = {
    type: "data-step-file-tree";
    /** Stable ID for reconciliation — unique per step within a run. */
    id: string;
    runId: string;
    stepId: string;
    /** Current file tree snapshot. May be empty if sandbox hasn't written to disk yet. */
    files: FileTreeEntry[];
};

// ── Step Output (persistent, once per step) ─────────────────────────

export type StepOutputFile = {
    path: string;
    size: number;
    /** File category for grouping/icons. */
    fileType: "script" | "output" | "figure" | "log" | "notebook" | "summary";
    /** LLM-generated description of the file contents. */
    description: string;
};

export type StepOutputPart = {
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
};

// ── Step Summary (persistent, once per step) ────────────────────────

/** Step summary — free-form markdown body, rendered verbatim by the UI. */
export type StepSummaryPart = {
    type: "data-step-summary";
    id: string;
    runId: string;
    stepId: string;
    agentId: string;
    /** Free-form markdown body. Render with a markdown renderer. */
    markdown: string;
};

// ── Step Usage (persistent, once per step) ──────────────────────────

/**
 * What one analysis-run step's agent loop reported spending, emitted when that
 * loop completes.
 *
 * `usage` is the step's rollup and is required: a part exists to carry one, so a
 * step whose loop reported nothing emits no part at all rather than one with an
 * absent or zeroed figure. Per-call granularity is the usage-record ledger's
 * job, never this part's.
 *
 * Scoped to analysis runs. Workflows without step parts (ephemeral runs, data
 * profiling) reach the ledger through the recorder seam and carry no usage part.
 */
export type StepUsagePart = {
    type: "data-step-usage";
    /** Stable ID for reconciliation — unique per step within a run. */
    id: string;
    runId: string;
    stepId: string;
    agentId: string;
    /**
     * The model id the step's agent was configured to run under — the identity
     * the rollup is attributable to. Whether the endpoint actually served that
     * model is a per-call question the usage-record ledger answers; a rollup
     * spans calls and cannot.
     */
    modelId: string;
    /** Summed token usage across this step loop's LLM calls. */
    usage: TokenUsageRollup;
};

// ── Step Blocked (persistent, once per step) ────────────────────────

/**
 * Emitted when a step agent declares it cannot fulfil its step via
 * `report_blocker` (see the harness-sandbox-agents spec). A blocked step has no deliverables; the
 * reason surfaces in the run side panel.
 */
export type StepBlockedPart = {
    type: "data-step-blocked";
    id: string;
    runId: string;
    stepId: string;
    agentId: string;
    /** Agent-declared reason the step could not be fulfilled. */
    reason: string;
};

// ── Run Completed ───────────────────────────────────────────────────

export type RunCompletedFinding = {
    title: string;
    confidence: "high" | "medium" | "low";
};

export type RunCompletedPart = {
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
    /**
     * The run's aggregate token usage — the sum of what its steps reported.
     * Absent when no step reported any, never an all-zero figure.
     */
    usage?: TokenUsageRollup;
};

// ── Run Synthesis (persistent, once per run) ────────────────────────

export type FindingReference = {
    pmid: string;
    citation: string;
    relevance: string;
    concordance: "supports" | "contradicts" | "extends" | "contextualizes";
};

export type SynthesizedFinding = {
    stepId: string;
    title: string;
    description: string;
    confidence: "high" | "medium" | "low";
    noveltyStatus: "novel" | "confirmed" | "partially_confirmed" | "contradicted" | "expected";
    literatureInterpretation: string;
    references: FindingReference[];
};

export type BiologicalTheme = {
    name: string;
    findings: { stepId: string; title: string }[];
    narrative: string;
};

export type RunSynthesisPart = {
    type: "data-run-synthesis";
    id: string;
    runId: string;
    overview: string;
    conclusions?: string;
    findings: SynthesizedFinding[];
    themes: BiologicalTheme[];
    limitations?: string[];
    keyReferences: { pmid: string; citation: string; description: string }[];
};

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

export type SynthesisProgressPart = {
    type: "data-synthesis-progress";
    /** Stable ID for reconciliation — `synthesis-progress-{runId}`. */
    id: string;
    runId: string;
    phase: SynthesisPhase;
    /** Human-readable activity description. */
    activity: string;
    /** ISO 8601 time of the emission. Absent in a stream that an older harness wrote. */
    at?: string;
    /** Number of literature-reviewer delegations started so far. */
    delegationCount?: number;
    /** Agent-provided reason — set when phase === "skipped". */
    reason?: string;
    /** Error message — set when phase === "failed". */
    error?: string;
};

// ── Run Failed ──────────────────────────────────────────────────────

export type RunFailedPart = {
    type: "data-run-failed";
    runId: string;
    /** Scrubbed error message (no internal details). */
    error: string;
    /**
     * The suspend reason of the host, carried unread, when the run suspended.
     * `canceled` when an external cancel ended the run. Absent for a failure.
     */
    reason?: string;
};

// ── Child Session Started (parent→child session spawn) ─────────────

/**
 * The record that a turn started a child session. It rides the chat stream
 * live, and it persists into the turn at the position of the spawn.
 *
 * The part is a placement record and a freshness signal only. The thread
 * store is the authority for the session: its existence, its title, and its
 * archived state. When the thread of the part is archived or absent, a
 * consumer renders nothing for it.
 */
export type ChildSessionStartedPart = {
    type: "data-child-session-started";
    /** The id of the child thread that the spawn made. */
    threadId: string;
    /** The id of the conversation thread that spawned it. */
    parentThreadId: string;
    /**
     * The type of the child thread, in the thread store's vocabulary.
     * Known values today: `"report"`.
     */
    threadType: string;
};

// ── Report Rendered (report session preview) ───────────────────────

/**
 * The record that a report-session preview rendered the page. It rides the
 * chat stream live, and it persists into the turn at the position of the
 * render.
 *
 * The part is a placement record and a freshness signal only. The version
 * store and the session-page mint stay the authority for what is viewable:
 * the part carries no path, no format, and no URL. A consumer that wants the
 * page reads those surfaces.
 */
export type ReportRenderedPart = {
    type: "data-report-rendered";
    /** Unique per emission. */
    id: string;
    /** The ISO timestamp of the successful render. */
    renderedAt: string;
    /** The title of the rendered document. */
    title?: string;
};

// ── Compaction (reconciling) ────────────────────────────────────────

/** One compaction of the thread: `running`, then `done` or `failed` under the same id. A reload shows it as a divider. */
export type CompactionPart = {
    type: "data-compaction";
    id: string;
    status: "running" | "done" | "failed";
    /** The input tokens that the provider reported for the last request before the compaction. */
    tokensBefore: number;
    /** Only a part that an older harness stored carries it: an estimate of the view after the compaction. */
    tokensAfter?: number;
    durationMs?: number;
    /** Before the user message of a turn, or before a later request. */
    trigger?: "turn-start" | "mid-turn";
};

// ── Sub-agent activity (reconciling) ────────────────────────────────

/** One tool call of a sub-agent. It holds no input, no output, and no text of the sub-agent. */
export type SubAgentActivityEntry = {
    agentId: string;
    callPath: string[];
    tool: string;
    /** The one-line detail of the call, normalized, redacted, and capped by the loop. */
    label?: string;
    /** ISO 8601. */
    startedAt: string;
    /** ISO 8601. Absent while the call is in flight and for an `incomplete` call. */
    endedAt?: string;
    /** Absent while the call is in flight. A stored entry always has it. */
    outcome?: ToolCallOutcome;
};

/**
 * The tool calls of the sub-agents below one root tool call. Re-emitted under the same `id` after each change,
 * so reconciling readers keep the latest list.
 */
export type SubAgentActivityPart = {
    type: "data-subagent-activity";
    id: string;
    /** The id of the root tool call. */
    toolCallId: string;
    entries: SubAgentActivityEntry[];
    /** The count of calls past the cap of the entries. */
    dropped: number;
};

// ── Union ───────────────────────────────────────────────────────────

export type ChatPart =
    | PresentationPart
    | PlanPart
    | RunCardPart
    | PlanApprovalPart
    | FileReferencePart
    | AskPart
    | RunStartedPart
    | DagStatePart
    | StepActivityPart
    | ActivityEntryPart
    | SubAgentActivityPart
    | StepFileTreePart
    | StepOutputPart
    | StepSummaryPart
    | StepUsagePart
    | StepBlockedPart
    | RunSynthesisPart
    | SynthesisProgressPart
    | RunCompletedPart
    | RunFailedPart
    | ChildSessionStartedPart
    | ReportRenderedPart
    | CompactionPart;
