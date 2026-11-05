import type { RunDetail, RunSummary } from "../api/runs.ts";

/**
 * A `running` {@link RunSummary} row for the run fixtures. `workflowId` mirrors `runId` (the workflow
 * the run executes is named after it), and `over` replaces the fields a case is about — `threadId`
 * among them, so a fixture states the binding its surface reads instead of inheriting one.
 */
export function runRowFixture(over: Partial<RunSummary> & { runId: string }): RunSummary {
    return {
        threadId: null,
        planId: null,
        workflowName: "executeAnalysis",
        workflowId: over.runId,
        status: "running",
        startedAt: "2026-07-28T10:00:00.000Z",
        completedAt: null,
        error: null,
        ...over,
    };
}

/**
 * The run as `GET {A}/run/:runId` gives it while the run is active: the row plus ONE running step, so
 * a progress entry carries a label and a denominator to count against.
 */
export function runDetailFixture(run: RunSummary): RunDetail {
    return {
        ...run,
        steps: [
            {
                stepId: "T1S1",
                agentId: "bioinformatician",
                status: "running",
                startedAt: "2026-07-28T10:00:01.000Z",
                completedAt: null,
                durationMs: null,
                error: null,
                attempts: 1,
                blockedReason: null,
            },
        ],
        plan: null,
        unattributedUsage: null,
    };
}
