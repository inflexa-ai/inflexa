/**
 * TargetAssessmentProgressStream — the read side of a target assessment's
 * durable progress stream.
 *
 * `emitProgress` (the sibling `progress.ts`) writes one part per phase
 * transition and nothing reads it back, so an embedder that wants to show a
 * user how far an assessment has got had to reach for the durability engine
 * itself. This seam is that read, and it quarantines the engine the way
 * `RunLauncher` does for starting workflows: the delivered value is the
 * harness's own `TargetAssessmentProgressEvent` contract type, and no engine
 * type appears in the exported signature.
 *
 * It is far simpler than `execution/run-event-stream.ts`, and deliberately so.
 * A run fans out over a parent workflow and every sandbox-step child, each
 * writing its own stream, so that seam polls a ledger to discover children and
 * folds reconciling parts before delivery. A target assessment writes progress
 * from the parent body alone, under `workflowID === assessmentId`. One stream,
 * no discovery, no pool.
 *
 * It is a push subscription rather than a returned iterator because handing the
 * engine's async generator back to a caller would put the engine's model on the
 * very surface this seam exists to remove, and would leave nowhere to contain a
 * failure. A handler gives both, and matches the `EmitFn` idiom the writer side
 * already speaks.
 */

import { DBOS } from "@dbos-inc/dbos-sdk";

import { TargetAssessmentProgressEventSchema, type TargetAssessmentProgressEvent } from "@inflexa-ai/harness/contracts/target-dossier.js";

import { createNoopLogger } from "../../lib/console-logger.js";
import type { Logger } from "../../lib/logger.js";
import { TA_PROGRESS_STREAM_KEY } from "./progress.js";

/**
 * Construction-time dependencies. The logger is where every contained failure
 * is reported, and defaults to silence so an embedder that wired none sees
 * nothing rather than having console forced on it.
 */
export interface TargetAssessmentProgressStreamDeps {
    readonly logger?: Logger;
}

/**
 * Receives one progress event. May be async — the subscription awaits it, so a
 * handler is never invoked concurrently with itself. A throw is logged and
 * swallowed.
 */
export type TargetAssessmentProgressHandler = (event: TargetAssessmentProgressEvent) => void | Promise<void>;

/** Call-time parameters of one subscription. */
export interface TargetAssessmentProgressSubscribeOptions {
    /** The assessment to observe. Also the workflow's id — TA sets the two equal. */
    readonly assessmentId: string;
    /** Where each delivered event goes. */
    readonly onEvent: TargetAssessmentProgressHandler;
    /** Aborting stops delivery and settles the returned promise. */
    readonly signal: AbortSignal;
}

/**
 * The progress read seam. One method, because an assessment-scoped subscription
 * is the whole capability — a general-purpose stream reader would leak the
 * engine's model back into the surface this exists to quarantine.
 */
export interface TargetAssessmentProgressStream {
    /**
     * Deliver every progress event the assessment produces to `onEvent`,
     * resolving when the assessment's stream drains or when the signal aborts.
     *
     * The stream drains when the workflow stops being active. A workflow that
     * self-cancels on a 402 is no longer active, so the stream drains at the
     * `suspended` phase and this settles there — it does NOT wait for a later
     * `DBOS.resumeWorkflow`. Re-opening across a resume would mean polling the
     * row's status, which is the caller's business, not this seam's.
     *
     * Events arrive in the order the workflow wrote them, each exactly once.
     * There is no fold: the body emits each phase once and the engine caches a
     * step's stream-write offset, so a recovered workflow does not re-write one.
     * A fold would collapse nothing and cost a buffer.
     */
    subscribe(options: TargetAssessmentProgressSubscribeOptions): Promise<void>;
}

/**
 * Shape `emitProgress` writes. The `data-target-assessment-progress` key is not
 * in the chat-part registry — it is the writer's private envelope — so the
 * payload, not the envelope, is what a caller gets.
 */
function readEvent(value: unknown): TargetAssessmentProgressEvent | null {
    if (typeof value !== "object" || value === null) return null;
    const parsed = TargetAssessmentProgressEventSchema.safeParse((value as { payload?: unknown }).payload);
    return parsed.success ? parsed.data : null;
}

/** Build the DBOS-backed realization of {@link TargetAssessmentProgressStream}. */
export function createTargetAssessmentProgressStream(deps: TargetAssessmentProgressStreamDeps = {}): TargetAssessmentProgressStream {
    const baseLogger = (deps.logger ?? createNoopLogger()).named("ta-progress-stream");

    return {
        async subscribe({ assessmentId, onEvent, signal }: TargetAssessmentProgressSubscribeOptions): Promise<void> {
            const logger = baseLogger.with({ assessmentId });

            let resolveAbort!: () => void;
            const aborted = new Promise<void>((resolve) => {
                resolveAbort = resolve;
            });

            const generator = DBOS.readStream<unknown>(assessmentId, TA_PROGRESS_STREAM_KEY);

            // The engine's reader exposes no cancellation: while it waits on a
            // quiet-but-active workflow it is suspended inside an await, where a
            // queued `return()` is only honoured once it next reaches a yield.
            // Teardown is therefore best-effort by construction, and the read's
            // own promise is raced against the signal rather than waiting on it.
            const onAbort = (): void => {
                resolveAbort();
                void generator.return(undefined).catch(() => {
                    /* the read is already being abandoned */
                });
            };
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });

            const read = (async (): Promise<void> => {
                try {
                    for (;;) {
                        const next = await generator.next();
                        // Checked after the read, not before: `next()` is what
                        // notices the workflow going inactive, and an aborted
                        // subscription must deliver nothing further.
                        if (next.done === true || signal.aborted) return;
                        const event = readEvent(next.value);
                        if (event === null) {
                            logger.debug("dropped a stream value outside the progress contract");
                            continue;
                        }
                        try {
                            await onEvent(event);
                        } catch (err) {
                            logger.warn("progress handler threw", { phase: event.phase, ...logger.errorFields(err) });
                        }
                    }
                } catch (err) {
                    // Observation is a diagnostic channel: `emitProgress` already
                    // treats a failed write as best-effort so a lost frame cannot
                    // fail the workflow. A read that propagated here would be
                    // strictly less robust than the writer it observes.
                    logger.error("progress stream read failed", logger.errorFields(err));
                } finally {
                    void generator.return(undefined).catch(() => {
                        /* already finished, or abandoned under abort */
                    });
                }
            })();

            try {
                await Promise.race([read, aborted]);
            } finally {
                signal.removeEventListener("abort", onAbort);
            }
        },
    };
}
