/**
 * Custom OTel metrics for Cortex.
 *
 * Instruments:
 *   - cortex.run.completed{status, workflow}      — counter, one per run that reached a terminal status
 *   - cortex.run.duration{status, workflow}       — histogram, start to terminal status
 *   - cortex.step.completed{status, agent_id}     — counter, one per executed step that settled
 *   - cortex.step.duration{status, agent_id}      — histogram, step start to its terminal ledger write
 *   - cortex.sandbox.execs{outcome}               — counter, one per sandbox exec that returned a terminal result
 *   - cortex.sandbox.exec.duration{outcome}       — histogram, the runtime the sandbox reported for that exec
 *   - cortex.sandbox.exec.peak_memory_bytes{outcome} — histogram, the peak resident set of that exec
 *   - cortex.sandbox.exec.cpu_seconds{outcome}    — histogram, the CPU time of that exec
 *   - cortex.sandbox.lease.wait{backend}          — histogram, from a lease request to its grant
 *   - cortex.sandbox.machine.start{backend}       — histogram, from a spawn to the health of the machine
 *   - cortex.sandbox.machine.replaced{cause}      — counter, one per machine of a lease that went away
 *   - cortex.artifact.reconcile.dropped{agent_id}              — counter for missing manifest entries
 *   - cortex.artifact.reconcile.input_dropped{agent_id, reason} — counter for lineage input drops
 *
 * Every label is a bounded vocabulary: `status` is the terminal enum, `workflow`
 * names the workflow family, `agent_id` has about 15 values, `outcome` has
 * five. No instrument carries a run, step, exec, user, or organization id — a
 * label with unbounded values multiplies the series count, and the collector
 * drops a datapoint that carries one.
 *
 * A run or step outcome is recorded INSIDE the DBOS step that persists the same
 * outcome to the ledger (or behind the ledger's own compare-and-set where the
 * body has no such step). DBOS caches a completed step and does not re-run its
 * body on recovery, so a replayed workflow records nothing twice. An exec has
 * no such step, so `recordSandboxExec` carries its own idempotence — see the
 * note on `countedExecs`.
 *
 * Instruments are lazy so the record site binds to whichever `MeterProvider`
 * is globally registered at first use. The metrics API has no late-binding
 * proxy: a meter taken at module load, before `initOtel` runs, would stay
 * on the no-op provider for the life of the process.
 */

import { type Counter, type Histogram, metrics, type UpDownCounter } from "@opentelemetry/api";

import type { WorkKind } from "../contracts/chat-parts.js";
import type { StepExecutionStatus } from "../state/schema.js";

/** Terminal status of a run, the same as the run ledger. */
export type RunOutcome = "completed" | "partial" | "failed" | "canceled";

/** The workflow family a run belongs to. */
export type RunWorkflow = "analysis" | "data_profile";

/** Terminal status of an executed step. A blocker is a failure to deliver, so `blocked` maps here to `failed`. */
export type StepOutcome = "completed" | "failed" | "canceled";

/**
 * Terminal outcome of one sandbox exec. `nonzero` is the command's own
 * verdict; `timeout` is the deadline; the two synthetic values name a machine
 * that died under the command, which is an outcome of the platform and not of
 * the analysis. Five values, thus five series for each instrument.
 */
export type SandboxExecOutcome = "ok" | "nonzero" | "timeout" | "synthetic-dead" | "synthetic-oom";

/**
 * Bucket bounds for durations that run from seconds to hours: 30 s, then
 * 1, 2, 5, 10, 30, 60, 120, 240 min. Ten buckets with the overflow, so one
 * histogram costs about ten series per label set.
 */
export const RUN_DURATION_BOUNDS_MS: readonly number[] = [30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000];

/**
 * Bucket bounds for one exec, which runs from a sub-second probe to an
 * hours-long analysis: 1, 5, 15, 30 s, then 1, 5, 15, 30, 60 min. The run
 * bounds start at 30 s and would put almost every exec in the first bucket.
 */
export const EXEC_DURATION_BOUNDS_MS: readonly number[] = [1_000, 5_000, 15_000, 30_000, 60_000, 300_000, 900_000, 1_800_000, 3_600_000];

/**
 * Bucket bounds for the peak resident set of one exec, in bytes: 128 MiB up to
 * 128 GiB by doubling. The top bound is the largest memory a step can request
 * (`SANDBOX_MAX_MEMORY_GB`), thus the overflow bucket holds only a sandbox that
 * outgrew its own ceiling.
 */
export const SANDBOX_PEAK_MEMORY_BOUNDS_BYTES: readonly number[] = [
    134_217_728, 536_870_912, 1_073_741_824, 2_147_483_648, 4_294_967_296, 8_589_934_592, 17_179_869_184, 34_359_738_368, 68_719_476_736, 137_438_953_472,
];

/**
 * Bucket bounds for the CPU time of one exec, in seconds: sub-second up to four
 * hours. Read against `cortex.sandbox.exec.duration` it gives the mean core
 * count the command held, which is what says whether its CPU request was worth
 * granting.
 */
export const SANDBOX_CPU_SECONDS_BOUNDS: readonly number[] = [0.5, 1, 5, 15, 60, 300, 900, 1_800, 3_600, 14_400];

/**
 * Bucket bounds for a cold start and for a wait in the lease queue: 1, 5, 15, 30 s, then 1, 2, 5, 10, 30, 60 min.
 * A machine on a ready node starts in seconds, and a new node or a full local budget takes minutes.
 */
export const SANDBOX_WAIT_BOUNDS_MS: readonly number[] = [1_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000];

/** Why a machine of a lease went away. */
export type MachineReplacementCause = "idle" | "dead" | "oom" | "release";

type Instruments = {
    readonly runCompleted: Counter;
    readonly runDuration: Histogram;
    readonly stepCompleted: Counter;
    readonly stepDuration: Histogram;
    readonly sandboxExecs: Counter;
    readonly sandboxExecDuration: Histogram;
    readonly sandboxExecPeakMemory: Histogram;
    readonly sandboxExecCpuSeconds: Histogram;
    readonly sandboxLeaseWait: Histogram;
    readonly sandboxMachineStart: Histogram;
    readonly sandboxMachineReplaced: Counter;
    readonly sandboxLeaseWorkflows: UpDownCounter;
    readonly workPaused: UpDownCounter;
    readonly artifactReconcileDropped: Counter;
    readonly lineageInputDropped: Counter;
};

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
            sandboxExecs: meter.createCounter("cortex.sandbox.execs", {
                description: "Sandbox execs that returned a terminal result. Tagged by outcome.",
                unit: "{exec}",
            }),
            sandboxExecDuration: meter.createHistogram("cortex.sandbox.exec.duration", {
                description: "Runtime the sandbox reported for one exec. Tagged by outcome.",
                unit: "ms",
                advice: { explicitBucketBoundaries: [...EXEC_DURATION_BOUNDS_MS] },
            }),
            sandboxExecPeakMemory: meter.createHistogram("cortex.sandbox.exec.peak_memory_bytes", {
                description: "Peak resident set of one sandbox exec and of every descendant it waited for. Tagged by outcome.",
                unit: "By",
                advice: { explicitBucketBoundaries: [...SANDBOX_PEAK_MEMORY_BOUNDS_BYTES] },
            }),
            sandboxExecCpuSeconds: meter.createHistogram("cortex.sandbox.exec.cpu_seconds", {
                description: "User plus system CPU time of one sandbox exec. Tagged by outcome.",
                unit: "s",
                advice: { explicitBucketBoundaries: [...SANDBOX_CPU_SECONDS_BOUNDS] },
            }),
            sandboxLeaseWait: meter.createHistogram("cortex.sandbox.lease.wait", {
                description: "Wait of a sandbox lease from its request to its grant. Tagged by backend.",
                unit: "ms",
                advice: { explicitBucketBoundaries: [...SANDBOX_WAIT_BOUNDS_MS] },
            }),
            sandboxMachineStart: meter.createHistogram("cortex.sandbox.machine.start", {
                description: "Time from the spawn of a sandbox machine to its health. Tagged by backend.",
                unit: "ms",
                advice: { explicitBucketBoundaries: [...SANDBOX_WAIT_BOUNDS_MS] },
            }),
            sandboxMachineReplaced: meter.createCounter("cortex.sandbox.machine.replaced", {
                description: "Machines of a lease that went away. Tagged by cause.",
                unit: "{machine}",
            }),
            sandboxLeaseWorkflows: meter.createUpDownCounter("cortex.sandbox.lease.workflows", {
                description: "Lease workflows that run in this process. Each one waits in memory for the life of its lease.",
                unit: "{workflow}",
            }),
            workPaused: meter.createUpDownCounter("cortex.work.paused", {
                description: "Workflow bodies that wait in a pause in this process. Tagged by work_kind.",
                unit: "{workflow}",
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

/**
 * Exec ids already counted, so a replay counts one exec one time.
 *
 * The run and step counters sit inside the DBOS step that persists the same
 * outcome, and DBOS never runs a cached step body a second time. The exec
 * record sits inside the step of its exec too, but a step that did not finish
 * runs its body again on recovery. An exec id is `{workflowId}:{functionId}`
 * and it is stable across that second run, thus it is the key that makes the
 * record idempotent. The set is process-local: a recovery in a fresh process
 * holds no memory of the first count and can count that exec again.
 */
const countedExecs = new Set<string>();

/**
 * How many exec ids the guard remembers. A host runs far fewer concurrent
 * execs than this, and a replay follows its original within one run, thus the
 * cap only drops an id that no live workflow can present again.
 */
const MAX_COUNTED_EXECS = 4096;

/**
 * Record one sandbox exec that returned a terminal result. Call it at the one
 * seam where an `ExecResult` crosses from the wire into the process. A result
 * that carries no runtime (a synthetic failure) is counted, not timed.
 *
 * `peakMemoryBytes` and `cpuMillis` are the kernel accounting the sandbox
 * reports for the command. Each one is independent: a sandbox image that
 * predates the accounting, and an exec whose command never spawned, report
 * neither, thus a missing member records nothing rather than a zero.
 */
export function recordSandboxExec(args: {
    readonly execId: string;
    readonly outcome: SandboxExecOutcome;
    readonly durationMs?: number | null;
    readonly peakMemoryBytes?: number | undefined;
    readonly cpuMillis?: number | undefined;
}): void {
    if (countedExecs.has(args.execId)) return;
    if (countedExecs.size >= MAX_COUNTED_EXECS) {
        const oldest = countedExecs.values().next();
        if (!oldest.done) countedExecs.delete(oldest.value);
    }
    countedExecs.add(args.execId);
    const attributes = { outcome: args.outcome };
    const { sandboxExecs, sandboxExecDuration, sandboxExecPeakMemory, sandboxExecCpuSeconds } = getInstruments();
    sandboxExecs.add(1, attributes);
    if (args.durationMs !== undefined && args.durationMs !== null) sandboxExecDuration.record(Math.max(0, args.durationMs), attributes);
    if (args.peakMemoryBytes !== undefined) sandboxExecPeakMemory.record(Math.max(0, args.peakMemoryBytes), attributes);
    if (args.cpuMillis !== undefined) sandboxExecCpuSeconds.record(Math.max(0, args.cpuMillis) / 1000, attributes);
}

/** Record the wait of one lease from its request to its grant. Call it in the step that took the grant. */
export function recordLeaseWait(args: { readonly backend: string; readonly waitMs: number }): void {
    getInstruments().sandboxLeaseWait.record(Math.max(0, args.waitMs), { backend: args.backend });
}

/** Record the time from one spawn to the health of the machine. Call it in the step of the spawn. */
export function recordMachineStart(args: { readonly backend: string; readonly startMs: number }): void {
    getInstruments().sandboxMachineStart.record(Math.max(0, args.startMs), { backend: args.backend });
}

/** Record one machine of a lease that went away. Call it in the step that removed it. */
export function recordMachineReplaced(args: { readonly cause: MachineReplacementCause }): void {
    getInstruments().sandboxMachineReplaced.add(1, { cause: args.cause });
}

/**
 * Count one value in this process until the returned function runs. The count is of this process only, thus a
 * dashboard can put it beside the memory of the same process. A second call of the returned function does nothing.
 */
function track(counter: UpDownCounter, attributes?: Record<string, string>): () => void {
    counter.add(1, attributes);
    let open = true;
    return () => {
        if (!open) return;
        open = false;
        counter.add(-1, attributes);
    };
}

/** Count one lease workflow that runs in this process, until the returned function runs. */
export function trackLeaseWorkflow(): () => void {
    return track(getInstruments().sandboxLeaseWorkflows);
}

/** Count one workflow body that waits in a pause in this process, until the returned function runs. */
export function trackWorkPaused(args: { readonly workKind: WorkKind }): () => void {
    return track(getInstruments().workPaused, { work_kind: args.workKind });
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
    countedExecs.clear();
}
