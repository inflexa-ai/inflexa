/**
 * The pause of durable work (work-pause spec).
 *
 * A failure that a person or time can repair does not fail the work. The workflow that meets it waits in its own
 * body with `DBOS.recv`, on the topic of its pause, and the work goes on when the wait ends. The workflow stays
 * active, thus a recovery after a crash replays it to the same wait: the failed call, the row, and the part of the
 * pause come back from the checkpoints. A `recv` that completed replays its message, thus a resume never runs
 * twice.
 *
 * A wait in `retrying` ends at its deadline, and the work sends the request again. A wait in `paused` ends only
 * with the message of a resume, or with a stop. The server never sends that message by itself.
 */

import { DBOS } from "@dbos-inc/dbos-sdk";
import { z } from "zod";

import type { PauseCause, PausedWorkKind, PausePart } from "../contracts/chat-parts.js";
import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";
import { unwrapOrThrow } from "../lib/result.js";
import { isTurnCredentialMissing } from "../loop/turn-credentials.js";
import { modelFailureOf } from "../providers/errors.js";
import type { Querier } from "../state/db.js";
import { clearPause, recordPause } from "../state/paused-work.js";

/** The delays of the timer of an outage: 1, 5, 15, and 30 minutes. After the last one, the work waits in `paused`. */
export const DEFAULT_PAUSE_RETRY_DELAYS_MS: readonly number[] = [60_000, 300_000, 900_000, 1_800_000];

/**
 * One wait of the state `paused`, in seconds. The wait loops on it. A stop in the process of the turn leaves its
 * `recv` behind, and that `recv` polls no longer than this.
 */
const PAUSED_WAIT_SECONDS = 60 * 60;

/** The message that ends a wait. */
export const RESUME_MESSAGE = { kind: "resume" } as const;

/** The message that moves a wait in `retrying` to `paused`: the work waits for a resume, and the timer stops. */
export const HOLD_MESSAGE = { kind: "hold" } as const;

const ResumeMessageSchema = z.object({ kind: z.literal("resume") });
const HoldMessageSchema = z.object({ kind: z.literal("hold") });

/** The topic of the resume message of one pause. Each pause has its own topic, thus a late message never ends a later pause. */
export function pauseTopic(pauseId: string): string {
    return `pause:${pauseId}`;
}

/** The cause of a pause in a failure, or `undefined` for a failure that no person or time can repair. */
export function pauseCauseOf(failure: unknown): PauseCause | undefined {
    if (isTurnCredentialMissing(failure)) return { kind: "credential" };
    const model = modelFailureOf(failure);
    switch (model.kind) {
        case "billing":
            return { kind: "host", reason: model.reason };
        case "credential":
            return { kind: "credential" };
        case "outage":
            return { kind: "outage" };
        case "other":
            return undefined;
    }
}

/** How a wait ended: the deadline of `retrying`, the message of a resume, or a stop of the work. */
export type PauseEnd = "retry" | "resume" | "abort";

/** The work that a pause belongs to, and where the part of the pause goes. */
export type PauseScope = {
    readonly pool: Querier;
    /** The turn id, the run id, or the id of the profile workflow. A sub-agent names its turn, and a step its run. */
    readonly workId: string;
    readonly workKind: PausedWorkKind;
    readonly analysisId: string;
    readonly threadId?: string;
    /** Writes the part of the pause to the stream of the work. */
    readonly emit: (part: PausePart) => Promise<void>;
    /** The delays of the timer of an outage. Absent: {@link DEFAULT_PAUSE_RETRY_DELAYS_MS}. */
    readonly retryDelaysMs?: readonly number[];
    readonly logger?: Logger;
};

export type WorkPause = {
    /**
     * Wait out a failure. `attempt` is the count of timer retries of this pause so far. `undefined`: the failure has
     * no cause, or the code runs where no wait is possible, outside a workflow or inside a step.
     */
    readonly afterFailure: (failure: unknown, attempt: number, signal?: AbortSignal) => Promise<PauseEnd | undefined>;
    /** Wait out a cause, for example a gate refusal with the suspend flag. `undefined` where no wait is possible. */
    readonly forCause: (cause: PauseCause, attempt: number, signal?: AbortSignal) => Promise<PauseEnd | undefined>;
};

const STOPPED = Symbol("stopped");

/** Settles when the signal aborts, and never when there is no signal. */
function stopOf(signal: AbortSignal | undefined): Promise<typeof STOPPED> {
    return new Promise((resolve) => {
        if (signal === undefined) return;
        if (signal.aborted) resolve(STOPPED);
        else signal.addEventListener("abort", () => resolve(STOPPED), { once: true });
    });
}

async function waitForMessage(topic: string, delayMs: number | undefined, signal: AbortSignal | undefined): Promise<PauseEnd | "hold"> {
    const stopped = stopOf(signal);
    if (delayMs !== undefined) {
        // DBOS records the deadline of the timeout at the first call, thus a recovery waits until the same time.
        const message = await Promise.race([DBOS.recv<unknown>(topic, Math.ceil(delayMs / 1000)), stopped]);
        if (message === STOPPED) return "abort";
        if (HoldMessageSchema.safeParse(message).success) return "hold";
        return ResumeMessageSchema.safeParse(message).success ? "resume" : "retry";
    }
    for (;;) {
        const message = await Promise.race([DBOS.recv<unknown>(topic, PAUSED_WAIT_SECONDS), stopped]);
        if (message === STOPPED) return "abort";
        if (ResumeMessageSchema.safeParse(message).success) return "resume";
    }
}

/** The pause of the work of one workflow body. */
export function workPause(scope: PauseScope): WorkPause {
    const log = (scope.logger ?? createNoopLogger()).named("pause");
    const delays = scope.retryDelaysMs ?? DEFAULT_PAUSE_RETRY_DELAYS_MS;

    const forCause = async (cause: PauseCause, attempt: number, signal?: AbortSignal): Promise<PauseEnd | undefined> => {
        const workflowId = DBOS.workflowID;
        if (!DBOS.isInWorkflow() || DBOS.isInStep() || workflowId === undefined) return undefined;
        if (signal?.aborted === true) return "abort";
        const delayMs = cause.kind === "outage" ? delays[attempt] : undefined;
        const state = delayMs === undefined ? "paused" : "retrying";
        const pauseId = await DBOS.randomUUID();
        const pausedAt = await DBOS.now();
        const retryAt = delayMs === undefined ? undefined : new Date(pausedAt + delayMs).toISOString();
        const topic = pauseTopic(pauseId);
        const work = { workId: scope.workId, workKind: scope.workKind };
        await DBOS.runStep(
            async () =>
                unwrapOrThrow(
                    await recordPause(scope.pool, {
                        workflowId,
                        ...work,
                        analysisId: scope.analysisId,
                        threadId: scope.threadId,
                        state,
                        cause,
                        attempt,
                        retryAt,
                        topic,
                        pausedAt: new Date(pausedAt).toISOString(),
                    }),
                ),
            { name: "pause.record" },
        );
        await scope.emit({ type: "data-pause", id: workflowId, ...work, state, cause, attempt, retryAt });
        log.warn("work paused", { workflowId, ...work, state, cause: cause.kind, attempt });

        const waited = await waitForMessage(topic, delayMs, signal);
        let end: PauseEnd;
        if (waited === "hold") {
            // A person held the work: the timer stops, and the work waits for a resume.
            await DBOS.runStep(
                async () =>
                    unwrapOrThrow(
                        await recordPause(scope.pool, {
                            workflowId,
                            ...work,
                            analysisId: scope.analysisId,
                            threadId: scope.threadId,
                            state: "paused",
                            cause,
                            attempt,
                            topic,
                            pausedAt: new Date(pausedAt).toISOString(),
                        }),
                    ),
                { name: "pause.hold" },
            );
            await scope.emit({ type: "data-pause", id: workflowId, ...work, state: "paused", cause, attempt });
            log.info("work held", { workflowId, ...work, attempt });
            const held = await waitForMessage(topic, undefined, signal);
            end = held === "hold" ? "resume" : held;
        } else {
            end = waited;
        }

        await DBOS.runStep(async () => unwrapOrThrow(await clearPause(scope.pool, workflowId)), { name: "pause.clear" });
        await scope.emit({ type: "data-pause", id: workflowId, ...work, state: "running" });
        log.info("pause ended", { workflowId, ...work, end });
        return end;
    };

    return {
        afterFailure: async (failure, attempt, signal) => {
            const cause = pauseCauseOf(failure);
            return cause === undefined ? undefined : forCause(cause, attempt, signal);
        },
        forCause,
    };
}

/**
 * Wait out a gate refusal with the suspend flag, in the body of a workflow. The body calls the gate again after the
 * wait. A gate inside a workflow body can always wait, thus no wait is a defect of the call site.
 */
export async function pauseAtGate(pause: WorkPause, reason: string, signal?: AbortSignal): Promise<PauseEnd> {
    const end = await pause.forCause({ kind: "host", reason }, 0, signal);
    if (end === undefined) throw new Error("A gate refusal with the suspend flag cannot wait outside the body of a workflow.");
    return end;
}
