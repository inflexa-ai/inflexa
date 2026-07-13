/**
 * Colocated input fixtures for the prior-runs briefing snapshot tests —
 * representative `PriorRunsInput` values from the run-index reader. All
 * deterministic (fixed run ids and completion timestamps), so the briefing
 * renders identically on every run.
 */

import type { PriorRunEntry, PriorRunsInput } from "../../state/run-index.js";

/**
 * A mixed history: the latest run completed 6 of 7 steps with one failed step,
 * an earlier run failed outright. Matches the spec's caption example
 * (`2 prior runs · latest run_8f3a 6/7 steps · 2026-07-10`).
 */
export const priorRunsFixture: PriorRunsInput = {
    entries: [
        {
            runId: "run_8f3a",
            title: "AD lesional vs control DE + pathways",
            status: "completed",
            completedAt: "2026-07-10T14:30:00.000Z",
            steps: { completed: 6, total: 7, failedStepNames: ["qc_step"] },
        },
        {
            runId: "run_2b1c",
            title: "Bulk RNA-seq differential expression",
            status: "failed",
            completedAt: "2026-07-08T09:12:00.000Z",
            steps: { completed: 1, total: 4, failedStepNames: ["align_reads"] },
        },
    ],
    olderCount: 0,
};

/** A plan-less `run_ephemeral` run — the workflow name stands in as title, no steps. */
export const priorRunsStepLessFixture: PriorRunsInput = {
    entries: [
        {
            runId: "run_ep01",
            title: "run_ephemeral",
            status: "completed",
            completedAt: "2026-07-11T08:00:00.000Z",
            steps: { completed: 0, total: 0, failedStepNames: [] },
        },
    ],
    olderCount: 0,
};

/** An over-cap history: 10 indexed runs with 3 older terminal runs omitted. */
export const priorRunsOverCapFixture: PriorRunsInput = {
    entries: Array.from({ length: 10 }, (_, i): PriorRunEntry => {
        const n = 10 - i; // newest first: run 10 down to run 1
        return {
            runId: `run_${String(n).padStart(4, "0")}`,
            title: `Analysis pass ${n}`,
            status: "completed",
            completedAt: `2026-07-${String(n).padStart(2, "0")}T12:00:00.000Z`,
            steps: { completed: 3, total: 3, failedStepNames: [] },
        };
    }),
    olderCount: 3,
};
