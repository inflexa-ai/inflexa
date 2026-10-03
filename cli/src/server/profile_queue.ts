import { ResultAsync } from "neverthrow";

import { Bus } from "../lib/bus.ts";
import { getLogger } from "../lib/log.ts";
import { findAnalysesByRef } from "../db/primary_query.ts";
import { reprofileForInputChange, type ProfileParityOutcome } from "../modules/harness/profile_trigger.ts";
import type { HarnessRuntime } from "../modules/harness/runtime.ts";
import type { Analysis } from "../types/analysis.ts";
import type { StampedEvent } from "../types/events.ts";
import { sandboxRefusal } from "./sandbox_gate.ts";

// The profile work of each analysis runs one drive at a time. The harness ledger CAS serializes only the
// workflow dispatch, and it runs after the staging. Thus it cannot serialize the two things that race:
// `stageInputs` deletes each staged file that is absent from its own manifest, so a drive with a stale
// manifest can delete files that a second drive just linked, under a sandbox that reads them. And the
// `clearDataProfile` of an emptied set can land between the seed and the trigger of a second drive.
//
// Arrivals queue, they do not drop: an edge fires because the state changed, so a drive that arrives during
// a second drive must still run after it, against the new state. Each analysis has its own queue, because
// the race is inside one workspace tree and one ledger row.

type ProfileQueue = {
    tail: Promise<void>;
    /** The drives that are queued or that run. A count, because arrivals queue. */
    depth: number;
};

const queues = new Map<string, ProfileQueue>();

/**
 * True while a profile drive of the analysis is queued or runs. A drive stages the inputs into the `data/`
 * root of the analysis workspace, thus a caller that moves or removes that tree must wait for this.
 */
export function profileWorkInFlight(analysisId: string): boolean {
    return (queues.get(analysisId)?.depth ?? 0) > 0;
}

/** The count of the analyses with a profile drive that is queued or runs. An empty queue leaves the map. */
export function profileWorkCount(): number {
    return queues.size;
}

/** The analyses with an input change whose timer of {@link watchInputDrift} did not start the drive yet. */
const changesWaiting = new Set<string>();

/**
 * True while the server holds profile work of the analysis that its ledger row does not show yet: an input
 * change that waits for its drive, or a drive that is queued or runs.
 */
export function profileWorkPending(analysisId: string): boolean {
    return changesWaiting.has(analysisId) || profileWorkInFlight(analysisId);
}

/**
 * Run `work` after each drive of the analysis that is already queued. A rejected predecessor still lets its
 * successors run. The promise carries the outcome of `work`, so a caller still sees its rejection.
 */
export function serializeProfileWork(analysisId: string, work: () => Promise<void>): Promise<void> {
    const queue = queues.get(analysisId) ?? { tail: Promise.resolve(), depth: 0 };
    queues.set(analysisId, queue);
    queue.depth++;
    const next = queue.tail.then(work, work);
    // The tail cannot reject, thus one failure cannot skip each later drive. The depth goes down on the tail,
    // after the outcome of `work` settled, and the empty queue leaves the map.
    queue.tail = next.then(
        () => undefined,
        () => undefined,
    );
    void queue.tail.then(() => {
        queue.depth--;
        if (queue.depth === 0 && queues.get(analysisId) === queue) queues.delete(analysisId);
    });
    return next;
}

/**
 * The trailing-edge debounce of an input change. A batch edit emits a burst of `prov.input_*` events, and the
 * burst gets one re-profile.
 */
const INPUT_DRIFT_DEBOUNCE_MS = 500;

/**
 * How long an input change waits before it asks the sandbox gate again. The gate reads the container engine and
 * the store root, and no event tells the server that a download ended, thus the change asks again on a timer.
 */
const SANDBOX_RETRY_MS = 30_000;

/** What {@link watchInputDrift} reads and starts. Tests replace each one. */
export type InputDriftOpts = {
    /** The booted runtime, or `null` while the boot is not ready. An input change before `ready` waits for it. */
    readonly runtime: () => HarnessRuntime | null;
    /** The analysis row, or `null` when it is gone. */
    readonly analysis: (analysisId: string) => Analysis | null;
    /** The re-profile after an input change. Real: {@link reprofileForInputChange}. */
    readonly reprofile: (runtime: HarnessRuntime, analysis: Analysis) => Promise<ProfileParityOutcome>;
    /** Why a sandbox cannot start for the analysis now, or `null`. Real: {@link sandboxRefusal}. */
    readonly sandboxRefusal: (analysisId: string) => Promise<string | null>;
    /** Arm a one-shot timer, and give its cancel. */
    readonly schedule: (fn: () => void, ms: number) => () => void;
    readonly subscribe: (handler: (event: StampedEvent) => void) => () => void;
};

/** The production {@link InputDriftOpts}, over the runtime of `runtime`. */
export function defaultInputDriftOpts(runtime: () => HarnessRuntime | null): InputDriftOpts {
    return {
        runtime,
        analysis: (analysisId) =>
            findAnalysesByRef(analysisId).match(
                (candidates) => candidates.find((candidate) => candidate.id === analysisId) ?? null,
                () => null,
            ),
        reprofile: reprofileForInputChange,
        sandboxRefusal,
        schedule: (fn, ms) => {
            const handle = setTimeout(fn, ms);
            // A half-elapsed debounce must not keep the process alive at shutdown.
            handle.unref?.();
            return () => clearTimeout(handle);
        },
        subscribe: (handler) => {
            Bus.on("inflexa", handler);
            return () => Bus.off("inflexa", handler);
        },
    };
}

/**
 * Re-profile an analysis after its input set changes, from each writer: a route, and the `manage_inputs`
 * tool inside a turn. Each `prov.input_added` and `prov.input_removed` event arms a 500 ms trailing-edge
 * timer for its analysis, and the timer queues one {@link reprofileForInputChange} drive behind the profile
 * work of that analysis. A timer that fires before the runtime is ready arms again, thus the drive runs at the
 * first fire after the ready edge. A timer whose sandbox gate refuses arms again after 30 s, thus the change
 * waits until a sandbox can start. Gives the unsubscribe.
 */
export function watchInputDrift(opts: InputDriftOpts): () => void {
    const timers = new Map<string, () => void>();
    let stopped = false;
    function arm(analysisId: string, ms: number = INPUT_DRIFT_DEBOUNCE_MS): void {
        changesWaiting.add(analysisId);
        timers.get(analysisId)?.();
        timers.set(
            analysisId,
            opts.schedule(() => fire(analysisId), ms),
        );
    }
    function fire(analysisId: string): void {
        timers.delete(analysisId);
        // Read at fire time: the runtime can go down, and the analysis can go away, in the window.
        const runtime = opts.runtime();
        // The boot gives this watch no ready event, thus the timer arms again. Each wait costs one read of the boot
        // phase, and a failed boot keeps the change until a later boot is ready.
        if (runtime === null) {
            arm(analysisId);
            return;
        }
        void ResultAsync.fromPromise(opts.sandboxRefusal(analysisId), (cause) => cause)
            .match(
                (refusal) => refusal,
                (err) => {
                    getLogger("server").warn({ err, analysisId }, "the sandbox check of a re-profile threw");
                    return "the sandbox check failed";
                },
            )
            .then((refusal) => {
                if (stopped) {
                    changesWaiting.delete(analysisId);
                    return;
                }
                // A newer input event armed its own timer during the check, and that timer drives the change.
                if (timers.has(analysisId)) return;
                if (refusal !== null) {
                    getLogger("server").debug({ analysisId, reason: refusal }, "the re-profile after an input change waits for the sandbox");
                    arm(analysisId, SANDBOX_RETRY_MS);
                    return;
                }
                // The queue of the drive takes over in the same synchronous step, thus `profileWorkPending` has no gap.
                changesWaiting.delete(analysisId);
                const analysis = opts.analysis(analysisId);
                if (analysis === null) return;
                void serializeProfileWork(analysisId, async () => {
                    const outcome = await opts.reprofile(runtime, analysis);
                    if (outcome.kind === "failed")
                        getLogger("server").warn({ analysisId, reason: outcome.reason }, "the re-profile after an input change failed");
                }).catch((err: unknown) => getLogger("server").error({ err, analysisId }, "the re-profile after an input change threw"));
            });
    }
    const unsubscribe = opts.subscribe((event) => {
        if (event.type !== "prov.input_added" && event.type !== "prov.input_removed") return;
        arm(event.analysisId);
    });
    return () => {
        stopped = true;
        unsubscribe();
        for (const [analysisId, cancel] of timers) {
            cancel();
            changesWaiting.delete(analysisId);
        }
        timers.clear();
    };
}

/** Test hook: forget each queue. Test-only. */
export function __resetProfileQueueForTest(): void {
    queues.clear();
    changesWaiting.clear();
}
