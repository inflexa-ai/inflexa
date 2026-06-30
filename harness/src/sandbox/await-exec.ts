/**
 * `awaitExec` — the workflow-body recv loop on the per-exec DBOS topic.
 *
 * Runs in the workflow body (NOT a DBOS step) because `DBOS.recv` and
 * `DBOS.writeStream` are body-only. On each received envelope:
 *
 *   1. If it carries `signature: null` and the payload is a
 *      `synthetic-failure` done-marker, accept it — the watchdog is an
 *      in-process trusted sender. Any other null-signature message
 *      hard-cancels.
 *   2. Otherwise HMAC-verify against the per-sandbox `callbackSecret`.
 *      A bad or stale signature throws `HardCancelError`, which DBOS
 *      treats as a fatal workflow error (no retry).
 *   3. If the verified payload is a done-marker, return its `result`.
 *   4. Otherwise forward the payload via `emit` and continue.
 *
 * `deadline` is an absolute unix-ms timestamp — the durable backstop
 * (typically `step.timeout`). `T` is liveness-agnostic recv pacing: we
 * use `min(5s, remaining)` so the loop returns often enough to honour
 * the deadline.
 */

import { DBOS } from "@dbos-inc/dbos-sdk";

import { verifyCallback } from "./hmac.js";
import { ExecResultSchema, isDoneMarker, isSyntheticFailure, type ExecEmit, type ExecEventMessage, type ExecResult } from "./types.js";

const DEFAULT_FRESHNESS_SECONDS = 300;
const MAX_RECV_TIMEOUT_SECONDS = 5;

export class HardCancelError extends Error {
    readonly execId: string;
    readonly reason: "bad-signature" | "stale-timestamp" | "missing" | "synthetic-without-marker";
    constructor(execId: string, reason: "bad-signature" | "stale-timestamp" | "missing" | "synthetic-without-marker", detail?: string) {
        super(`awaitExec[${execId}]: hard cancel — ${reason}${detail ? ` (${detail})` : ""}`);
        this.execId = execId;
        this.reason = reason;
    }
}

export class ExecTimeoutError extends Error {
    readonly execId: string;
    constructor(execId: string) {
        super(`awaitExec[${execId}]: deadline exceeded before done-marker`);
        this.execId = execId;
    }
}

export interface AwaitExecOptions {
    /** Symmetric HMAC freshness window. Defaults to 5 minutes. */
    freshnessSec?: number;
    /**
     * Clock source for the deadline check and HMAC freshness. Defaults to the
     * checkpointed `DBOS.now()` so the loop's recv count is replay-stable (a raw
     * `Date.now()` here drifts the recorded `DBOS.recv` function-ID sequence on
     * recovery — see the harness-durable-runtime spec). Overridable as a testing hook.
     */
    now?: () => number | Promise<number>;
    /**
     * Injected for tests: replaces `DBOS.recv`. Production code passes
     * nothing and the real `DBOS.recv` is used.
     */
    recv?: <T>(topic: string, timeoutSec: number) => Promise<T | null>;
}

/**
 * Body of the recv loop. Hoisted so it's testable without spinning up
 * DBOS — `recv` is injectable and `now` is overridable.
 */
export async function awaitExec(
    execId: string,
    callbackSecret: string,
    emit: ExecEmit,
    deadlineMs: number,
    options: AwaitExecOptions = {},
): Promise<ExecResult> {
    const topic = `exec-event:${execId}`;
    const freshnessSec = options.freshnessSec ?? DEFAULT_FRESHNESS_SECONDS;
    const now = options.now ?? (() => DBOS.now());
    const recv = options.recv ?? (async <T>(t: string, sec: number) => DBOS.recv<T>(t, sec));

    while (true) {
        const remainingMs = deadlineMs - (await now());
        if (remainingMs <= 0) {
            throw new ExecTimeoutError(execId);
        }
        const timeoutSec = Math.min(MAX_RECV_TIMEOUT_SECONDS, Math.max(1, Math.ceil(remainingMs / 1000)));

        const msg = await recv<ExecEventMessage>(topic, timeoutSec);
        if (msg === null) {
            // Timeout this iteration; loop and re-check the deadline.
            continue;
        }

        if (msg.signature === null) {
            if (isSyntheticFailure(msg.payload)) {
                return ExecResultSchema.parse(msg.payload.result);
            }
            throw new HardCancelError(execId, "synthetic-without-marker");
        }

        // Verify against the exact bytes sandbox-server signed. The route
        // preserves them as `payloadRaw`; the JSON.stringify fallback exists
        // only for messages persisted before that field was added — re-
        // serializing diverges from Go's HTML-escaping encoder.
        const bodyBytes = Buffer.from(msg.payloadRaw ?? JSON.stringify(msg.payload), "utf8");
        const result = verifyCallback({
            execId,
            body: bodyBytes,
            signature: msg.signature,
            timestamp: msg.timestamp,
            secret: callbackSecret,
            nowSec: Math.floor((await now()) / 1000),
            freshnessSec,
        });
        if (!result.valid) {
            throw new HardCancelError(execId, result.reason);
        }

        if (isDoneMarker(msg.payload)) {
            return ExecResultSchema.parse(msg.payload.result);
        }
        await emit(msg.payload);
    }
}
