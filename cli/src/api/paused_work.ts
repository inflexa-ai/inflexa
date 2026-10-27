import type { PausedWork as HarnessPausedWork, PausedWorkflow as HarnessPausedWorkflow } from "@inflexa-ai/harness/app/paused-work.js";

import type { ListEnvelope } from "./common.ts";

// The wire types of the paused-work routes: `GET {A}/paused-work` and `POST {A}/paused-work/:workId/resume`. Each
// harness type here is a type-only import of the file that defines it, because the root barrel of the harness loads
// its runtime.

/** One waiting workflow of paused work: the harness `PausedWorkflow`. `retryAt` and `pausedAt` are ISO 8601. */
export type PausedWorkflow = HarnessPausedWorkflow;

/**
 * One paused work of an analysis: a chat turn, a run, or a data profile, with each of its waiting workflows. A
 * sub-agent of a turn waits under the turn id, and a step of a run under the run id, thus a resume names the work.
 */
export type PausedWork = HarnessPausedWork & {
    /**
     * The remedy that the server knows for the cause `credential`, the same line as for a failed turn with that
     * cause. Absent when no waiting workflow of the work has the cause `credential`.
     */
    readonly remedy?: string;
};

/** The body of `GET {A}/paused-work`: the paused work of the analysis. */
export type PausedWorkList = ListEnvelope<"pausedWork", PausedWork>;

/** The body of `POST {A}/paused-work/:workId/resume`: the count of the workflows that got the resume. */
export type ResumedWork = {
    workId: string;
    workflows: number;
};
