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

import { formatTokenFigure } from "../../lib/usage_format.ts";
import type { AskCardPart, TextPart, ThinkingPart, ToolCallPart, FileEditPart, PlanCardPart, PlanCardStepView, RunCardPart } from "../../types/session.ts";
import type { ActiveProfileProgress, ActiveRunProgress } from "../hooks/sidebar_live.ts";
import type { SessionUsageSnapshot } from "../components/dialog/usage_dialog.tsx";
import type { LlmUsageTotals } from "../../db/primary_query.ts";

/** A run step's lifecycle state (mirrors `RunStepView.state`). */
export type StepState = "done" | "running" | "failed" | "queued";

/** MOCK: one step within a run. */
export type RunStep = {
    id: string;
    /** Human label shown in the step list. */
    label: string;
    state: StepState;
    /** ISO start time of a running step — drives the elapsed-age readout beside the label. */
    startedAt?: string | null;
    /**
     * The step's token figure, ALREADY WRITTEN (mirrors `RunStepView.usageFigure`, which is a
     * pre-rendered string by contract).
     *
     * Every value here is produced by the REAL {@link formatTokenFigure} over sample quantities rather
     * than typed out as a literal, so a fixture can never spell a figure the shared notation would not
     * write. Steps that carry none are the honest majority case — a step whose calls reported no
     * quantity gets no line at all, never a zeroed one.
     */
    usageFigure?: string;
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
    detail: "src/db/types.ts :55-105",
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
        {
            id: "s1",
            name: "QC & normalize counts",
            agent: "rna-preprocess",
            question: "Are the count matrices suitable for differential analysis?",
            acceptance_criteria: ["All samples pass count-depth checks", "Normalized matrix is written"],
            constraints: ["Preserve sample labels"],
            caveats: [],
            depends_on: [],
            resources: { cpu: 2, memoryGb: 4, gpuCount: 0 },
            track: "preprocess",
            step_type: "analysis",
        },
        {
            id: "s2",
            name: "Fit DE model",
            agent: "deseq2",
            question: "Which genes differ between conditions?",
            acceptance_criteria: ["Adjusted p-values are reported"],
            constraints: [],
            caveats: ["Small cohorts reduce power"],
            depends_on: ["s1"],
            resources: { cpu: 4, memoryGb: 8, gpuCount: 0 },
            track: "differential-expression",
            step_type: "analysis",
        },
        {
            id: "s3",
            name: "Pathway enrichment on DE genes",
            agent: "pathway",
            question: "Which pathways explain the differential signal?",
            acceptance_criteria: ["Enriched pathways include effect direction"],
            constraints: [],
            caveats: ["Gene-set overlap may inflate related terms"],
            depends_on: ["s2"],
            resources: { cpu: 2, memoryGb: 4, gpuCount: 0 },
            track: "interpretation",
            step_type: "analysis",
        },
    ],
};

function galleryPlanStep(id: string, name: string, depends_on: string[] = []): PlanCardStepView {
    return {
        id,
        name,
        agent: "scientific-executor",
        question: `What should ${name.toLowerCase()} establish?`,
        acceptance_criteria: ["Produces a reviewable result"],
        constraints: [],
        caveats: [],
        depends_on,
        resources: { cpu: 2, memoryGb: 4, gpuCount: 0 },
        track: "analysis",
        step_type: "analysis",
    };
}

export const mockPlanStepDetail = galleryPlanStep("B", "Expression analysis", ["A"]);

/** MOCK plan shapes that pin every dependency-graph gallery state. */
export const mockPlanGraphExhibits = {
    linear: [galleryPlanStep("A", "Load inputs"), galleryPlanStep("B", "Analyze", ["A"]), galleryPlanStep("C", "Summarize", ["B"])],
    branching: [
        galleryPlanStep("A", "Load inputs"),
        mockPlanStepDetail,
        galleryPlanStep("C", "Variant analysis", ["A"]),
        galleryPlanStep("D", "Integrate findings", ["B", "C"]),
    ],
    wide: [
        galleryPlanStep("A", "Load inputs"),
        galleryPlanStep("B1", "QC", ["A"]),
        galleryPlanStep("B2", "Expression", ["A"]),
        galleryPlanStep("B3", "Variants", ["A"]),
        galleryPlanStep("B4", "Pathways", ["A"]),
    ],
    longLabel: [galleryPlanStep("A", "A deliberately long plan step label that must truncate")],
    empty: [],
} satisfies Record<string, PlanCardStepView[]>;

/** MOCK sample: a launched run card (identity + step count; no live status field, per the contract). */
export const mockRunCard: RunCardPart = {
    id: "mock-run-card",
    type: "run-card",
    runId: "run-3c07",
    title: "Differential expression across conditions",
    stepCount: 3,
};

/**
 * MOCK: the primitive fields the docked approval prompt renders — the exhibit supplies the
 * approve/reject callbacks. The feedback surface (reject → optional feedback input) carries no
 * title/command of its own; the gallery reaches it by seeding the widget's `initialMode="feedback"`
 * with these same fields filling the required props.
 */
export type AskPromptFixture = {
    /** Short headline naming what needs approval. */
    title: string;
    /** The exact action awaiting approval, shown verbatim. */
    command: string;
    /** Optional secondary context line under the command. */
    detail?: string;
    /** Further asks waiting behind this one; drives the `+N more` hint (0 hides it). */
    queuedCount: number;
};

/** MOCK ask-prompt states pinning the docked approval prompt's choice-mode surface. */
export const mockAskPrompts = {
    basic: {
        title: "Approve shell command",
        command: "Rscript scripts/deseq2.R --cores 8",
        queuedCount: 0,
    },
    withDetail: {
        title: "Fetch external dataset",
        command: "curl -O https://ftp.ncbi.nlm.nih.gov/geo/GSE78220_series_matrix.txt.gz",
        detail: "downloads ~40 MB into the analysis sandbox before profiling",
        queuedCount: 0,
    },
    queued: {
        title: "Install R package",
        command: "install.packages('fgsea')",
        queuedCount: 2,
    },
} satisfies Record<string, AskPromptFixture>;

/**
 * MOCK: a reconciled ask card in each of the five statuses the transcript renders — `pending` plus its
 * four terminal outcomes (`resolved`/`rejected`/`aborted`/`expired`). A live-turn-only visual; these
 * exist only so the gallery can show every ask-card state without a live approval round-trip.
 */
export const mockAskCards: AskCardPart[] = [
    {
        id: "mock-ask-pending",
        type: "ask-card",
        askId: "mock-askid-pending",
        title: "Approve shell command",
        command: "Rscript scripts/deseq2.R --cores 8",
        detail: "runs in the analysis sandbox",
        status: "pending",
    },
    {
        id: "mock-ask-resolved",
        type: "ask-card",
        askId: "mock-askid-resolved",
        title: "Install R package",
        command: "install.packages('fgsea')",
        status: "resolved",
    },
    {
        id: "mock-ask-rejected",
        type: "ask-card",
        askId: "mock-askid-rejected",
        title: "Delete output directory",
        command: "rm -rf runs/run-abc/output",
        status: "rejected",
        feedback: "don't delete outputs — archive them instead",
    },
    {
        id: "mock-ask-aborted",
        type: "ask-card",
        askId: "mock-askid-aborted",
        title: "Fetch external dataset",
        command: "curl -O https://ftp.ncbi.nlm.nih.gov/geo/GSE78220_series_matrix.txt.gz",
        status: "aborted",
    },
    {
        id: "mock-ask-expired",
        type: "ask-card",
        askId: "mock-askid-expired",
        title: "Write outside workspace",
        command: "cp report.html ~/Desktop/",
        status: "expired",
    },
];

/**
 * MOCK sample: a live run with a mix of step states.
 *
 * The first three steps carry a figure and the queued one does not — a step that has not run has
 * nothing to report, and the absence is the state the gallery must show beside the reported ones.
 */
export const mockRun: Run = {
    id: "mock-run",
    name: "drug-repurposing",
    tag: "T5S1",
    status: "running",
    done: 13,
    total: 20,
    steps: [
        { id: "mock-step-12", label: "rank consensus", state: "done", usageFigure: formatTokenFigure({ inputTokens: 42_600, outputTokens: 1_100 }) },
        {
            id: "mock-step-13",
            label: "build report",
            state: "running",
            startedAt: Date.ago(4 * 60_000),
            usageFigure: formatTokenFigure({ inputTokens: 9_400, outputTokens: 320 }),
        },
        // A failed step still spent what it spent — the figure is not an outcome, so it stays.
        { id: "mock-step-14", label: "score targets", state: "failed", usageFigure: formatTokenFigure({ inputTokens: 3_100, outputTokens: 45 }) },
        { id: "mock-step-15", label: "queued", state: "queued" },
    ],
};

/**
 * MOCK sample: a long run whose step count clears the rail window's break-even point (`maxSteps=7`), so
 * the gallery exhibit shows the window engaging — centred on the frontier (the first non-done step),
 * clamped to the ends, bracketed by the clickable elision markers naming the hidden counts — while the
 * bar and `done/total` still reflect the full 12-step run. Twelve steps, not nine: a run only a step or
 * two over the cap renders whole (the markers would cost more rows than they save), so a shorter fixture
 * would exhibit the unwindowed state and silently stop covering the window at all. The frontier sits far
 * enough in that steps are hidden on BOTH sides, which is what lets the exhibit show scrolling either
 * way — and the single step hidden below also exercises the marker's singular wording.
 *
 * The steps INSIDE the default window carry a deliberate mix of figures, because the rail is the mount
 * the figure line was designed against: a figure takes a row of its own there, so the window's row
 * count is what a reviewer has to be able to see. `cluster` is the one done step with none — a step
 * whose calls reported no quantity renders no line rather than a zero, and that state has to sit
 * beside the reported ones to be judged.
 */
export const mockLongRun: Run = {
    id: "mock-long-run",
    name: "cohort-screen",
    tag: "T9S2",
    status: "running",
    done: 7,
    total: 12,
    steps: [
        { id: "mock-lstep-1", label: "ingest cohort", state: "done" },
        { id: "mock-lstep-2", label: "harmonize schemas", state: "done" },
        { id: "mock-lstep-3", label: "qc filter", state: "done" },
        { id: "mock-lstep-4", label: "normalize", state: "done" },
        { id: "mock-lstep-5", label: "batch correct", state: "done", usageFigure: formatTokenFigure({ inputTokens: 128_400, outputTokens: 6_200 }) },
        { id: "mock-lstep-6", label: "cluster", state: "done" },
        { id: "mock-lstep-7", label: "annotate types", state: "done", usageFigure: formatTokenFigure({ inputTokens: 61_900, outputTokens: 2_800 }) },
        {
            id: "mock-lstep-8",
            label: "differential test",
            state: "running",
            startedAt: Date.ago(6 * 60_000),
            usageFigure: formatTokenFigure({ inputTokens: 24_500, outputTokens: 910 }),
        },
        { id: "mock-lstep-9", label: "pathway enrich", state: "queued" },
        { id: "mock-lstep-10", label: "score targets", state: "queued" },
        { id: "mock-lstep-11", label: "rank consensus", state: "queued" },
        { id: "mock-lstep-12", label: "build report", state: "queued" },
    ],
};

/** MOCK sample: the harness run ledger for the RUNS details view (newest-first, mixed statuses). */
export const mockCortexRuns: CortexRunRow[] = [
    {
        runId: "mock-run-9a3f4c21",
        analysisId: "mock-analysis",
        threadId: null,
        workflowName: "executeAnalysis",
        status: "running",
        startedAt: Date.ago(4 * 60_000),
        completedAt: null,
        error: null,
        synthesisStatus: null,
        synthesisReason: null,
        parts: null,
        mandateJti: null,
        mandateExpiresAt: null,
        planId: "mock-plan-8f21",
    },
    {
        runId: "mock-run-71bd0e55",
        analysisId: "mock-analysis",
        threadId: null,
        workflowName: "executeAnalysis",
        status: "completed",
        startedAt: Date.ago(3 * 3_600_000),
        completedAt: Date.ago(2 * 3_600_000),
        error: null,
        synthesisStatus: "produced",
        synthesisReason: null,
        parts: null,
        mandateJti: null,
        mandateExpiresAt: null,
        planId: "mock-plan-6b0c",
    },
    {
        runId: "mock-run-2c07af90",
        analysisId: "mock-analysis",
        threadId: null,
        workflowName: "executeAnalysis",
        status: "failed",
        startedAt: Date.ago(2 * 86_400_000),
        completedAt: Date.ago(2 * 86_400_000 - 5 * 60_000),
        error: "step_failed",
        synthesisStatus: null,
        synthesisReason: null,
        parts: null,
        mandateJti: null,
        mandateExpiresAt: null,
        planId: null,
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
    startedAt: Date.ago(5 * 60_000),
    completedAt: Date.ago(4 * 60_000),
    result: {
        summary: "12 samples across 2 conditions; counts pass QC with no dropped libraries.",
        files: [
            { path: "data/counts.tsv", description: "gene-by-sample raw counts" },
            { path: "data/meta.csv", description: "sample metadata (condition, batch)" },
        ],
        inputFileIds: ["mock-input-counts", "mock-input-meta"],
        profiledAt: Date.ago(4 * 60_000),
    },
    workflowId: null,
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
        startedAt: Date.ago(4 * 60_000),
        completedAt: Date.ago(3 * 60_000),
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
        startedAt: Date.ago(2 * 60_000),
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
        startedAt: Date.ago(90_000),
        completedAt: Date.ago(60_000),
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

/**
 * MOCK: the run-card identity the lifecycle exhibits share, so every state in that block is visibly
 * the SAME card changing rather than four unrelated cards.
 */
export const mockRunCardIds = { runId: "run-3c07-9f21-4a88" } as const;

/**
 * MOCK: an active run's progress, as the run-activity panel receives it. A factory rather than a
 * constant because the panel's exhibits vary one field at a time (a stale read, a parallel frontier),
 * and each needs its own object — the panel reads `steps` reactively, so sharing one array across
 * exhibits would couple them.
 */
export function galleryRun(over: Partial<ActiveRunProgress> = {}): ActiveRunProgress {
    return {
        runId: mockRunCardIds.runId,
        name: "Differential expression across conditions",
        tag: "3c0794",
        // Fixed rather than "now": the panel renders a relative age, and a live clock would make the
        // gallery's frames differ run to run.
        startedAt: "2026-07-28T10:00:00.000Z",
        done: 1,
        total: 4,
        steps: [
            { label: "quality control", state: "done", startedAt: null },
            { label: "align reads", state: "running", startedAt: null, agent: "bioinformatician" },
            { label: "call variants", state: "queued", startedAt: null },
            { label: "summarize findings", state: "queued", startedAt: null },
        ],
        stale: false,
        ...over,
    };
}

/**
 * MOCK: the running data profile's progress, as the run-activity panel receives it. A factory for the
 * same reason {@link galleryRun} is one — the exhibits vary a single field at a time.
 *
 * Carries no name and no counts because the type has neither: the panel's name for a profile is a
 * constant it renders itself, and a profile has no step decomposition to count.
 */
export function galleryProfile(over: Partial<ActiveProfileProgress> = {}): ActiveProfileProgress {
    return {
        analysisId: "mock-analysis",
        // Fixed rather than "now", for the same reason as the run fixture: a live clock would make the
        // gallery's captured frames differ between runs.
        startedAt: "2026-07-28T10:02:30.000Z",
        // A realistic shape — `dataprofile:{analysisId}:{nonce}` is what the harness mints — so a reader
        // can see that a profile is addressed by its WORKFLOW id, not by a run id.
        workflowId: "dataprofile:mock-analysis:9f21f0d4-4a88-4c07-9b31-2e6a5c1f7d80",
        stale: false,
        ...over,
    };
}

/**
 * MOCK: one conversation's ledger snapshot, as the usage dialog reads it — the RICH state, carrying
 * all five quantities so the headline shows both arms with the cache counts nested under input and the
 * reasoning count under output.
 *
 * The three readings RECONCILE, and that is a correctness property of the fixture rather than
 * decoration: the headline and both groupings come from three SQL aggregates over the SAME rows, so a
 * snapshot whose groups do not sum to its total is a reading the ledger could never return. Per
 * quantity — calls 36+9+2=47, in 795.8k+11.1k=806.9k, out 39.5k+2.9k=42.4k, cache write 12.8k+4.2k=17k,
 * cache read 742k+6.4k=748.4k, reasoning 9.1k — and the model cut partitions the same 47 calls.
 *
 * The magnitudes are the shape a real conversation-with-a-run has (see the note above
 * `getSessionUsageTotalsIncludingRuns`): the chat's own turns are a rounding error beside the run it
 * launched, which is exactly why this reading names itself "runs included" on screen.
 *
 * Two absences ride along so the absent vocabulary is on screen beside real figures: a served-model
 * group with no id (an endpoint that reported no model, labelled as an absence, never as a model
 * actually named that) and a sub-agent whose provider reported no quantity at all (rendered as the
 * absent word, never as a zero — its call count is what says the work happened).
 */
export const mockUsageSnapshot: SessionUsageSnapshot = {
    totals: {
        calls: 47,
        inputTokens: 806_900,
        outputTokens: 42_400,
        cacheCreationInputTokens: 17_000,
        cacheReadInputTokens: 748_400,
        reasoningTokens: 9_100,
    },
    byModel: [
        {
            servedModelId: "claude-opus-4",
            totals: {
                calls: 45,
                inputTokens: 806_900,
                outputTokens: 42_400,
                cacheCreationInputTokens: 17_000,
                cacheReadInputTokens: 748_400,
                reasoningTokens: 9_100,
            },
        },
        { servedModelId: null, totals: { calls: 2 } },
    ],
    byAgent: [
        {
            agentId: "bioinformatician",
            totals: {
                calls: 36,
                inputTokens: 795_800,
                outputTokens: 39_500,
                cacheCreationInputTokens: 12_800,
                cacheReadInputTokens: 742_000,
                reasoningTokens: 9_100,
            },
        },
        {
            agentId: "conversation",
            totals: { calls: 9, inputTokens: 11_100, outputTokens: 2_900, cacheCreationInputTokens: 4_200, cacheReadInputTokens: 6_400 },
        },
        { agentId: "literature-reviewer", totals: { calls: 2 } },
    ],
};

/**
 * MOCK: a conversation whose provider reported prompt tokens and never completion tokens — the HALF
 * figure, which is a normal reading and not a broken one.
 *
 * It exists because the notation's whole reason for using arrows rather than a positional
 * `806.9k/42.4k` is that this state has to render as an absence rather than as a typo. A reviewer can
 * only judge that by seeing the one-armed headline with the output column beside it saying so.
 */
export const mockUsageSnapshotInputOnly: SessionUsageSnapshot = {
    totals: { calls: 6, inputTokens: 128_400 },
    byModel: [{ servedModelId: "gemini-2.5-pro", totals: { calls: 6, inputTokens: 128_400 } }],
    byAgent: [{ agentId: "conversation", totals: { calls: 6, inputTokens: 128_400 } }],
};

/**
 * MOCK: a conversation whose calls ran but whose provider reported NO quantity at all.
 *
 * Distinct from {@link mockUsageSnapshotEmpty}, and the distinction is the point: work happened here.
 * The call count is the only thing that can say so, which is why it sits beside figures that are words
 * rather than numbers — a zeroed figure would assert the work was free.
 */
export const mockUsageSnapshotNoFigures: SessionUsageSnapshot = {
    totals: { calls: 3 },
    byModel: [{ servedModelId: null, totals: { calls: 3 } }],
    byAgent: [{ agentId: "conversation", totals: { calls: 3 } }],
};

/**
 * MOCK: a conversation with nothing recorded — the state every chat opens in, and the exact value
 * `readSessionUsage` synthesizes for a chat whose Postgres thread identity is not bound yet.
 */
export const mockUsageSnapshotEmpty: SessionUsageSnapshot = { totals: { calls: 0 }, byModel: [], byAgent: [] };

/**
 * MOCK: what each run in {@link mockCortexRuns} consumed, keyed by run id — the shape the runs picker
 * batches in ONE local-ledger read and then hands to the detail dialog as data.
 *
 * Three states across three runs, deliberately: the running run reports both arms, the completed one
 * reports input only (the half figure on a compact row), and the failed one is ABSENT from the map
 * entirely — a run with no ledger rows contributes no figure segment at all rather than a zeroed one.
 */
export const mockRunUsage: ReadonlyMap<string, LlmUsageTotals> = new Map([
    ["mock-run-9a3f4c21", { calls: 47, inputTokens: 809_200, outputTokens: 40_400 }],
    ["mock-run-71bd0e55", { calls: 12, inputTokens: 96_100 }],
]);

/**
 * MOCK: what each step of {@link mockRunSteps} consumed, keyed by step id — read per opened run and
 * handed to the detail dialog as data, the same contract {@link mockRunUsage} has for the run itself.
 *
 * `pathway-enrichment` is deliberately ABSENT and `synthesis` deliberately reports nothing: a step
 * that never ran and a step whose provider measured nothing both carry no figure, and the exhibit has
 * to show that a run's step list is not a column of figures with holes punched in it. The three
 * present figures do NOT add up to the run's 809.2k above, which is also deliberate — a run's own
 * calls (planning, synthesis dispatch) are not attributed to any step.
 */
export const mockRunStepUsage: ReadonlyMap<string, LlmUsageTotals> = new Map([
    ["qc-normalize", { calls: 8, inputTokens: 121_400, outputTokens: 6_200 }],
    ["fit-de-model", { calls: 21, inputTokens: 402_900, outputTokens: 18_700 }],
    ["synthesis", { calls: 3 }],
]);
