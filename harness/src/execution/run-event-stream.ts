/**
 * RunEventStream — the read side of the durable per-run event stream.
 *
 * Every analysis run already writes a rich, typed event stream: the parent
 * `executeAnalysis` workflow writes the run-level parts, and each `sandbox-step`
 * child writes its own step-level parts to its OWN stream, because a workflow can
 * only write the stream it owns. This seam reads all of them back as one channel,
 * so an embedder can show a user what a run is actually doing without
 * reconstructing progress from the durability engine's internal step-cache tables
 * — which record a step only when it *completes*, and so describe the thing that
 * just finished rather than the thing in flight.
 *
 * The seam quarantines the engine the same way `RunLauncher` does for starting
 * workflows: the delivered values are the harness's own `contracts/` part types,
 * and no engine type appears in the exported signature.
 *
 * It is a push subscription rather than a snapshot reader because the engine's
 * read primitive is an async generator with no offset parameter — "give me what
 * is new since X" is not expressible on the public API, and expressing it would
 * mean reaching into the SDK internals this seam exists to remove. A merged async
 * iterator was the other candidate and was rejected because the set of sources
 * grows during iteration (children join mid-run), which costs materially more
 * code than invoking a handler; a callback also matches the `EmitFn` idiom the
 * producers already speak.
 *
 * `subscribe` resolves rather than returning a `Result` because it has no failure
 * to report. Observation is a diagnostic channel: a throwing handler and a
 * failing stream are both logged and contained, mirroring the `safeEmit` stance
 * on the write side, where a dropped UI frame must never fail a step. A read side
 * that tore itself down on one bad part would be strictly less robust than the
 * writer it observes.
 */

import { DBOS } from "@dbos-inc/dbos-sdk";
import type { ResultAsync } from "neverthrow";
import type { Pool } from "pg";

import type { ChatPart, RunFailedPart } from "../contracts/chat-parts.js";
import { sleep } from "../lib/async-utils.js";
import { createNoopLogger } from "../lib/console-logger.js";
import { describeDbError, type DbError } from "../lib/db-result.js";
import type { Logger } from "../lib/logger.js";
import { queryRun } from "../state/runs.js";
import type { RunStatus } from "../state/schema.js";
import { queryStepsByRun } from "../state/step-executions.js";
import { foldRunEventParts, parseRunEventPart } from "./run-event-parts.js";

/** Durable stream key every run producer writes its parts under. */
const RUN_EVENT_STREAM_KEY = "events";

/**
 * How often the run's step ledger is re-read for children that have started
 * since the last look.
 *
 * A child records its own workflow id as it begins, so discovery can only be as
 * timely as that write and there is nothing to subscribe to before it lands.
 * Polling is the honest mechanism: the parent's dag snapshot marks a step running
 * before the child's body has written its row, so an event-driven re-check would
 * race the ledger. One second matches the engine's own stream-polling fallback,
 * and lagging a child's first writes costs nothing — a stream subscribed late is
 * still read from its beginning.
 */
const CHILD_DISCOVERY_INTERVAL_MS = 1_000;

/**
 * The reads of the run row for a run whose parent stream ended with no terminal
 * part. The canceler writes `canceled` to the row after the engine cancel, thus
 * the stream can end before the row changes, and the later reads wait out that
 * window.
 */
const CANCELED_ROW_READ_ATTEMPTS = 4;
const CANCELED_ROW_READ_INTERVAL_MS = 500;

/**
 * Construction-time dependencies. The pool is the application pool the run
 * ledger lives in; the logger is where every contained failure is reported, and
 * defaults to silence so an embedder that wired none sees nothing rather than
 * having console forced on it.
 */
export interface RunEventStreamDeps {
    readonly pool: Pool;
    readonly logger?: Logger;
    /** Reads the status of the run row, `null` when no row exists. Defaults to `queryRun` on `pool`. */
    readonly readRunStatus?: (runId: string) => ResultAsync<RunStatus | null, DbError>;
    /** The wait between two reads of the run row. Defaults to a timer. */
    readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Receives one part. May be async — the subscription awaits it, so a handler is
 * never invoked concurrently with itself and back-pressure is the caller's to
 * exert by taking its time. A throw is logged and swallowed.
 */
export type RunEventPartHandler = (part: ChatPart) => void | Promise<void>;

/** Call-time parameters of one subscription. */
export interface RunEventSubscribeOptions {
    /** The run to observe. Also the parent workflow's id. */
    readonly runId: string;
    /** Where each delivered part goes. */
    readonly onPart: RunEventPartHandler;
    /** Aborting stops delivery and settles the returned promise. */
    readonly signal: AbortSignal;
}

/**
 * The run-event read seam. One method, because a run-scoped subscription is the
 * whole capability: a general-purpose stream reader would leak the engine's model
 * back into the surface this exists to quarantine.
 */
export interface RunEventStream {
    /**
     * Deliver every part the run produces — parent and children alike — to
     * `onPart`, resolving when the run is terminal, every stream opened has
     * drained, and `onPart` has taken the last part, or promptly when the signal
     * aborts.
     *
     * A canceled workflow runs no more steps, thus it never writes its own
     * terminal part, and the canceler cannot write a stream. When the parent
     * stream ends with no `data-run-completed` or `data-run-failed` part and
     * the run row reads `canceled`, the last part delivered is a
     * `data-run-failed` part with `reason: "canceled"`.
     *
     * Parts from one workflow arrive in the order that workflow wrote them. No
     * order is promised ACROSS the parent and its children: those workflows
     * execute concurrently and the producers establish no cross-stream clock, so
     * a total order could only be synthesised from timestamps that were never
     * meant to be one. Consumers do not need it — every part is addressed by
     * `runId`/`stepId` and the reconciling fold is per id.
     */
    subscribe(options: RunEventSubscribeOptions): Promise<void>;
}

/**
 * Build the DBOS-backed realization of {@link RunEventStream}.
 *
 * Every stream is read from its beginning, and each workflow is opened at most
 * once per subscription. Replay is not a cost worked around here, it is what
 * makes attaching mid-run correct: a subscriber joining at minute ten receives
 * the run's whole history and folding it yields the true current state.
 * Re-opening a workflow would redeliver that history and duplicate every part
 * the fold does not reconcile.
 */
export function createRunEventStream(deps: RunEventStreamDeps): RunEventStream {
    const baseLogger = (deps.logger ?? createNoopLogger()).named("run-event-stream");
    const readRunStatus = deps.readRunStatus ?? ((runId: string) => queryRun(deps.pool, runId).map((row) => row?.status ?? null));
    const waitForRowRead = deps.sleep ?? sleep;

    return {
        async subscribe({ runId, onPart, signal }: RunEventSubscribeOptions): Promise<void> {
            const logger = baseLogger.with({ runId });

            // Open generators, so an abort can ask each to wind down. The engine's
            // reader exposes no cancellation: while it waits on a quiet-but-active
            // workflow it is suspended inside an await, where a queued `return()` is
            // only honoured once it next reaches a yield. Teardown is therefore
            // best-effort by construction, and the subscription's own promise is
            // raced against the signal rather than waiting on it.
            const open = new Set<AsyncGenerator<unknown, void, unknown>>();

            let resolveAbort!: () => void;
            const aborted = new Promise<void>((resolve) => {
                resolveAbort = resolve;
            });
            const onAbort = (): void => {
                resolveAbort();
                for (const generator of open) {
                    void generator.return(undefined).catch(() => {
                        /* the read is already being abandoned */
                    });
                }
            };
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });

            // Delivery is serialized through one queue across every stream. That
            // gives the fold a batch to collapse — whatever accumulated while the
            // previous handler call was in flight is reconciled before it is handed
            // over, which is what spares a mid-run subscriber the superseded
            // intermediates it replayed. The queue is FIFO and the fold keeps
            // survivors in place, so a single stream's write order survives it.
            const pending: ChatPart[] = [];
            let delivering = false;
            let delivered: Promise<void> = Promise.resolve();

            const drain = async (): Promise<void> => {
                delivering = true;
                try {
                    while (pending.length > 0 && !signal.aborted) {
                        const batch = pending.splice(0, pending.length);
                        for (const part of foldRunEventParts(batch)) {
                            if (signal.aborted) return;
                            try {
                                await onPart(part);
                            } catch (err) {
                                logger.warn("run-event handler threw", { partType: part.type, ...logger.errorFields(err) });
                            }
                        }
                    }
                } finally {
                    delivering = false;
                }
            };

            // The returned promise settles when the queue is empty, thus a caller
            // that awaits it knows that the handler took each part enqueued so far.
            const deliver = (): Promise<void> => {
                if (!delivering) delivered = drain();
                return delivered;
            };

            let sawTerminal = false;

            const readWorkflowStream = async (workflowId: string): Promise<void> => {
                const streamLogger = logger.with({ workflowId });
                const generator = DBOS.readStream<unknown>(workflowId, RUN_EVENT_STREAM_KEY);
                open.add(generator);
                try {
                    for (;;) {
                        const next = await generator.next();
                        // Checked after the read, not before: `next()` is what notices
                        // the workflow going inactive, and an aborted subscription
                        // must not enqueue anything the drain will never take.
                        if (next.done === true || signal.aborted) return;
                        const part = parseRunEventPart(next.value);
                        if (part === null) {
                            streamLogger.debug("dropped a stream value outside the chat-part contract");
                            continue;
                        }
                        if (part.type === "data-run-completed" || part.type === "data-run-failed") sawTerminal = true;
                        pending.push(part);
                        void deliver();
                    }
                } catch (err) {
                    // One stream's failure is contained here so the parent and every
                    // other child keep arriving.
                    streamLogger.error("run-event stream read failed", streamLogger.errorFields(err));
                } finally {
                    open.delete(generator);
                    void generator.return(undefined).catch(() => {
                        /* already finished, or abandoned under abort */
                    });
                }
            };

            const subscribed = new Set<string>([runId]);
            const childReads: Promise<void>[] = [];

            // Children are addressed by the id the workflow bodies already persist.
            // Deriving them from the scheduler's `${runId}-${idx}` naming would
            // hard-code a scheme that belongs to the scheduler, and the engine's own
            // child bookkeeping is internals of the kind this seam removes.
            const discoverChildren = async (): Promise<void> => {
                (await queryStepsByRun(deps.pool, runId)).match(
                    (rows) => {
                        for (const row of rows) {
                            const childWorkflowId = row.childWorkflowId;
                            if (childWorkflowId === null || subscribed.has(childWorkflowId)) continue;
                            subscribed.add(childWorkflowId);
                            childReads.push(readWorkflowStream(childWorkflowId));
                        }
                    },
                    (error) => {
                        logger.warn("child discovery failed", { err: describeDbError(error) });
                    },
                );
            };

            let parentDrained = false;
            const parentRead = readWorkflowStream(runId).finally(() => {
                parentDrained = true;
            });

            // The parent's stream draining IS the run reaching terminal: the engine
            // ends a read exactly when the workflow is no longer active. One further
            // pass runs after that — a child whose id landed in the ledger late is
            // still replayed from zero — and then discovery stops.
            const discovery = (async (): Promise<void> => {
                for (;;) {
                    if (signal.aborted) return;
                    await discoverChildren();
                    if (signal.aborted || parentDrained) return;
                    await Promise.race([sleep(CHILD_DISCOVERY_INTERVAL_MS), aborted, parentRead]);
                }
            })();

            const canceledTerminalPart = async (): Promise<RunFailedPart | null> => {
                for (let attempt = 1; attempt <= CANCELED_ROW_READ_ATTEMPTS; attempt++) {
                    const read = await readRunStatus(runId);
                    if (read.isErr()) {
                        logger.warn("run row read failed", { err: describeDbError(read.error) });
                    } else {
                        const status = read.value;
                        if (status === "canceled") return { type: "data-run-failed", runId, error: "Run canceled", reason: "canceled" };
                        // The launch writes the row before the workflow starts, thus
                        // no row means that the id is not an analysis run.
                        if (status === null) return null;
                        // Only an active row can still become `canceled`.
                        if (status !== "running" && status !== "suspended_insufficient_funds") return null;
                    }
                    if (attempt < CANCELED_ROW_READ_ATTEMPTS) await Promise.race([waitForRowRead(CANCELED_ROW_READ_INTERVAL_MS), aborted]);
                    if (signal.aborted) return null;
                }
                return null;
            };

            const settled = (async (): Promise<void> => {
                await discovery;
                await parentRead;
                await Promise.all(childReads);
                if (!sawTerminal && !signal.aborted) {
                    const terminal = await canceledTerminalPart();
                    if (terminal !== null) pending.push(terminal);
                }
                await deliver();
            })().catch((err: unknown) => {
                // Defensive: every stream read and every discovery pass contains its
                // own failure, so arriving here is a defect in this seam rather than
                // a runtime condition. Logged rather than left to surface as an
                // unhandled rejection after an abort already settled the caller.
                logger.error("run-event subscription failed", logger.errorFields(err));
            });

            try {
                await Promise.race([settled, aborted]);
            } finally {
                signal.removeEventListener("abort", onAbort);
            }
        },
    };
}
