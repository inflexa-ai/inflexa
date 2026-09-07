/**
 * Custom OTel metrics for Cortex.
 *
 * Instruments:
 *   - cortex.run.completed{status, workflow}      — counter, one per run that reached a terminal status
 *   - cortex.run.duration{status, workflow}       — histogram, start to terminal status
 *   - cortex.step.completed{status, agent_id}     — counter, one per executed step that settled
 *   - cortex.step.duration{status, agent_id}      — histogram, step start to its terminal ledger write
 *   - cortex.artifact.reconcile.dropped{agent_id}              — counter for missing manifest entries
 *   - cortex.artifact.reconcile.input_dropped{agent_id, reason} — counter for lineage input drops
 *
 * Every label is a bounded vocabulary: `status` is the terminal enum, `workflow`
 * names the workflow family, `agent_id` has about 15 values. No instrument
 * carries a run, step, exec, user, or organization id — a label with unbounded
 * values multiplies the series count.
 *
 * A run or step outcome is recorded INSIDE the DBOS step that persists the same
 * outcome to the ledger (or behind the ledger's own compare-and-set where the
 * body has no such step). DBOS caches a completed step and does not re-run its
 * body on recovery, so a replayed workflow records nothing twice.
 *
 * Instruments are lazy so the record site binds to whichever `MeterProvider`
 * is globally registered at first use. The metrics API has no late-binding
 * proxy: a meter taken at module load, before `initOtel` runs, would stay
 * on the no-op provider for the life of the process.
 */

import { type Counter, type Histogram, metrics } from "@opentelemetry/api";

import type { StepExecutionStatus } from "../state/schema.js";

/** Terminal status of a run. A budget pause records as `canceled`, the same as the run ledger. */
export type RunOutcome = "completed" | "partial" | "failed" | "canceled";

/** The workflow family a run belongs to. */
export type RunWorkflow = "analysis" | "target_assessment" | "data_profile";

/** Terminal status of an executed step. A blocker is a failure to deliver, so `blocked` maps here to `failed`. */
export type StepOutcome = "completed" | "failed" | "canceled";

/**
 * Bucket bounds for durations that run from seconds to hours: 30 s, then
 * 1, 2, 5, 10, 30, 60, 120, 240 min. Ten buckets with the overflow, so one
 * histogram costs about ten series per label set.
 */
export const RUN_DURATION_BOUNDS_MS: readonly number[] = [30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000];

interface Instruments {
    readonly runCompleted: Counter;
    readonly runDuration: Histogram;
    readonly stepCompleted: Counter;
    readonly stepDuration: Histogram;
    readonly artifactReconcileDropped: Counter;
    readonly lineageInputDropped: Counter;
}

let instruments: Instruments | undefined;

function getInstruments(): Instruments {
    if (instruments === undefined) {
        const meter = metrics.getMeter("cortex");
        const advice = { explicitBucketBoundaries: [...RUN_DURATION_BOUNDS_MS] };
        instruments = {
            runCompleted: meter.createCounter("cortex.run.completed", {
                description: "Runs that reached a terminal status. Tagged by status, workflow.",
                unit: "{run}",
            }),
            runDuration: meter.createHistogram("cortex.run.duration", {
                description: "Run duration from its start to its terminal status. Tagged by status, workflow.",
                unit: "ms",
                advice,
            }),
            stepCompleted: meter.createCounter("cortex.step.completed", {
                description: "Executed steps that settled. Tagged by status, agent_id.",
                unit: "{step}",
            }),
            stepDuration: meter.createHistogram("cortex.step.duration", {
                description: "Step duration from its start to its terminal ledger write. Tagged by status, agent_id.",
                unit: "ms",
                advice,
            }),
            artifactReconcileDropped: meter.createCounter("cortex.artifact.reconcile.dropped", {
                description:
                    "Manifest entries dropped because their on-disk file was missing at " +
                    "registration time (writes-then-deletes, renames). Tagged by agent_id.",
            }),
            lineageInputDropped: meter.createCounter("cortex.artifact.reconcile.input_dropped", {
                description:
                    "Tracked input reads dropped from lineage at reconcile because they are " +
                    "not content-attestable files of the analysis (directory reads, " +
                    "out-of-tree resolutions, paths absent at reconcile). Tagged by " +
                    "agent_id, reason.",
            }),
        };
    }
    return instruments;
}

/**
 * Record one run that reached a terminal status. Call it inside the DBOS step
 * that persists that status, or behind the ledger compare-and-set that accepted
 * it. `durationMs` is omitted when the start instant is unknown: the run is
 * then counted, not timed.
 */
export function recordRunCompleted(args: { readonly workflow: RunWorkflow; readonly status: RunOutcome; readonly durationMs?: number }): void {
    const attributes = { status: args.status, workflow: args.workflow };
    const { runCompleted, runDuration } = getInstruments();
    runCompleted.add(1, attributes);
    if (args.durationMs !== undefined) runDuration.record(Math.max(0, args.durationMs), attributes);
}

/**
 * Record one executed step that settled. Call it inside the DBOS step that
 * persists the terminal row, or inside the terminal step of the run for a
 * step whose own body never reached one. `durationMs` is omitted when the
 * step settled without a durable duration: it is then counted, not timed.
 */
export function recordStepCompleted(args: { readonly agentId: string; readonly status: StepOutcome; readonly durationMs?: number }): void {
    const attributes = { status: args.status, agent_id: args.agentId };
    const { stepCompleted, stepDuration } = getInstruments();
    stepCompleted.add(1, attributes);
    if (args.durationMs !== undefined) stepDuration.record(Math.max(0, args.durationMs), attributes);
}

/**
 * The step outcome that a terminal ledger status records. A status that is not
 * terminal (`pending`, `running`) or that names a step that never executed
 * (`skipped`) records no outcome.
 */
export function stepOutcomeOf(status: StepExecutionStatus): StepOutcome | undefined {
    switch (status) {
        case "completed":
            return "completed";
        case "failed":
        case "blocked":
            return "failed";
        case "canceled":
            return "canceled";
        case "pending":
        case "running":
        case "skipped":
            return undefined;
        default: {
            const _exhaustive: never = status;
            return _exhaustive;
        }
    }
}

/**
 * Milliseconds from a persisted ISO-8601 start instant to `nowMs`. `undefined`
 * when the ledger holds no start or an unparsable one, so the caller counts
 * without a duration instead of recording a bogus one.
 */
export function elapsedSinceIso(startedAt: string | null | undefined, nowMs: number = Date.now()): number | undefined {
    if (startedAt === null || startedAt === undefined) return undefined;
    const startedMs = Date.parse(startedAt);
    if (!Number.isFinite(startedMs)) return undefined;
    return Math.max(0, nowMs - startedMs);
}

/** Record one manifest entry dropped at reconcile. */
export function recordArtifactReconcileDropped(args: { readonly agentId: string }): void {
    getInstruments().artifactReconcileDropped.add(1, { agent_id: args.agentId });
}

export type LineageInputDropReason = "container-prefix" | "workspace-root" | "symlink-escape" | "missing" | "directory";

/** Record one tracked input read dropped from lineage at reconcile. */
export function recordLineageInputDropped(args: { readonly agentId: string; readonly reason: LineageInputDropReason }): void {
    getInstruments().lineageInputDropped.add(1, { agent_id: args.agentId, reason: args.reason });
}

/** Test hook — drop memoised instruments to rebind a fresh MeterProvider. */
export function __resetMetricsForTest(): void {
    instruments = undefined;
}
