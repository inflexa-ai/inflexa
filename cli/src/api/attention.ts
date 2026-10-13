import type { ThreadSummary } from "./conversation.ts";
import type { TerminalRunStatus } from "./runs.ts";

// The wire types of the attention read: the work that waits for the person, over each analysis. Timestamps are
// ISO 8601. Each item names its analysis, because the lists cross the analyses.

/** An open ask. */
export type AttentionAsk = {
    askId: string;
    analysisId: string;
    analysisName: string;
    /** The thread whose turn asked, or `null` for an ask that no thread owns. */
    threadId: string | null;
    title: string;
    command: string;
    createdAt: string;
    /** True when no turn runs on the thread of the ask, or the ask has no thread. */
    stale: boolean;
};

/** A run with a live workflow. */
export type AttentionActiveRun = {
    runId: string;
    analysisId: string;
    analysisName: string;
    threadId: string | null;
    /** The trimmed title of the plan of the run, or `null` when the run has none. */
    planTitle: string | null;
    doneSteps: number;
    totalSteps: number;
    startedAt: string;
};

/** A run that ended, and that the person did not mark as seen. */
export type AttentionUnseenRun = {
    runId: string;
    analysisId: string;
    analysisName: string;
    status: TerminalRunStatus;
    completedAt: string;
};

/** One of the newest conversation threads, with the name of its analysis. */
export type AttentionThread = ThreadSummary & {
    analysisName: string;
};

/** The body of `GET /api/v1/attention`. */
export type Attention = {
    /** Each open ask, the oldest first. */
    asks: AttentionAsk[];
    /** The runs with a live workflow, the newest start first. At most 200. */
    activeRuns: AttentionActiveRun[];
    /** The runs that the person did not see, among the newest 200 runs that ended since the seen baseline, the newest end first. */
    unseenRuns: AttentionUnseenRun[];
    /** The conversation threads that changed last, the newest first. */
    recentThreads: AttentionThread[];
};
