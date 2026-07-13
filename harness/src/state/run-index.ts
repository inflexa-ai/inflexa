/**
 * Run-index reader — the I/O half of the prior-runs briefing (see the
 * conversation-briefings spec, D2).
 *
 * The prior-runs `BriefingDefinition.render` must stay pure, so the ledger
 * joins live here: `loadRunIndex(pool, analysisId)` reads the analysis's
 * terminal runs from `cortex_runs`, their step outcomes from
 * `cortex_step_executions`, and each run's plan title facet from
 * `cortex_plans`, returning the typed `PriorRunsInput` the definition renders.
 * Both composition sites (main conversation, planner) share this one reader.
 *
 * The 10-run cap is applied HERE: only the runs that will actually render have
 * their steps/plan fetched, and the count of older terminal runs rides in the
 * input so the definition can close the index with an explicit truncation line.
 */

import type { Pool } from "pg";

import { unwrapOrThrow } from "../lib/result.js";
import { AnalysisPlanSchema } from "../schemas/workflow-state.js";
import { loadPlan } from "./plans.js";
import { queryRunsByAnalysis } from "./runs.js";
import type { CortexRunRow, RunStatus, StepExecutionRow } from "./schema.js";
import { queryStepsByRun } from "./step-executions.js";

/** The most-recent terminal runs the index renders in full; older ones are counted only. */
export const RUN_INDEX_CAP = 10;

/**
 * How many recent runs the reader scans to find terminal ones and count the
 * older overflow. Runs per analysis are bounded in practice; this ceiling keeps
 * the initial ledger read a single bounded query.
 */
const RUN_INDEX_SCAN_LIMIT = 200;

/** Max characters of a plan's analytical narrative used as a title fallback. */
const NARRATIVE_FACET_MAX = 100;

/** Terminal run statuses — facts that stay true, unlike in-flight runs. */
const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(["completed", "partial", "failed", "canceled"]);

/** Aggregated step outcomes for one indexed run. */
export interface PriorRunStepOutcomes {
    /** Steps that reached `completed`. */
    readonly completed: number;
    /** Total steps recorded for the run (0 for a step-less `run_ephemeral`). */
    readonly total: number;
    /** Ids of the run's `failed` steps, in wave order. */
    readonly failedStepNames: readonly string[];
}

/** One terminal run as an index entry — awareness facets, never result bodies. */
export interface PriorRunEntry {
    readonly runId: string;
    /** Plan title, a truncated plan narrative, or the workflow name (plan-less runs). */
    readonly title: string;
    readonly status: RunStatus;
    /** Terminal completion timestamp (ISO); null only on a malformed row. */
    readonly completedAt: string | null;
    readonly steps: PriorRunStepOutcomes;
}

/** The typed input the prior-runs `render` consumes — indexed runs plus overflow count. */
export interface PriorRunsInput {
    /** The most-recent terminal runs, newest first, capped at {@link RUN_INDEX_CAP}. */
    readonly entries: readonly PriorRunEntry[];
    /** How many older terminal runs exist beyond the cap (0 when none omitted). */
    readonly olderCount: number;
}

function aggregateStepOutcomes(steps: readonly StepExecutionRow[]): PriorRunStepOutcomes {
    const completed = steps.filter((s) => s.status === "completed").length;
    const failedStepNames = steps.filter((s) => s.status === "failed").map((s) => s.stepId);
    return { completed, total: steps.length, failedStepNames };
}

/**
 * The run's title facet: the plan title when set, else a truncated analytical
 * narrative (pre-title plans), else the workflow name — the graceful fallback
 * for plan-less `run_ephemeral` runs, which carry no plan at all.
 */
async function resolveTitle(pool: Pool, run: CortexRunRow, analysisId: string): Promise<string> {
    if (!run.planId) return run.workflowName;

    const plan = unwrapOrThrow(await loadPlan(pool, run.planId, { analysisId }));
    const parsed = AnalysisPlanSchema.safeParse(plan);
    if (!parsed.success) return run.workflowName;

    const { title, analytical_narrative } = parsed.data;
    if (title && title.trim().length > 0) return title.trim();

    const narrative = analytical_narrative.trim();
    if (narrative.length === 0) return run.workflowName;
    return narrative.length > NARRATIVE_FACET_MAX ? `${narrative.slice(0, NARRATIVE_FACET_MAX).trimEnd()}…` : narrative;
}

/**
 * Load the analysis's terminal-run index. Filters `cortex_runs` to terminal
 * statuses (newest first), caps the detailed entries at {@link RUN_INDEX_CAP},
 * and fetches steps + plan title only for those entries — the older terminal
 * runs are counted, not detailed. An analysis with no terminal runs returns an
 * empty input (`entries: []`, `olderCount: 0`); the composition site omits the
 * briefing on that.
 */
export async function loadRunIndex(pool: Pool, analysisId: string): Promise<PriorRunsInput> {
    const runs = unwrapOrThrow(await queryRunsByAnalysis(pool, analysisId, { limit: RUN_INDEX_SCAN_LIMIT }));
    const terminal = runs.filter((r) => TERMINAL_STATUSES.has(r.status));

    const indexed = terminal.slice(0, RUN_INDEX_CAP);
    const olderCount = terminal.length - indexed.length;

    const entries: PriorRunEntry[] = [];
    for (const run of indexed) {
        const steps = unwrapOrThrow(await queryStepsByRun(pool, run.runId));
        entries.push({
            runId: run.runId,
            title: await resolveTitle(pool, run, analysisId),
            status: run.status,
            completedAt: run.completedAt,
            steps: aggregateStepOutcomes(steps),
        });
    }

    return { entries, olderCount };
}
