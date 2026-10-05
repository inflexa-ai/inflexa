/**
 * One sandbox exec: submit the command, then poll until it is terminal.
 *
 * The whole exec runs inside ONE durable step (`SandboxClient.exec` wraps it),
 * thus nothing here touches DBOS but the cancellation read. The polls, the
 * sleeps, and the liveness probes are plain calls. A replay returns the cached
 * result of the step and never reaches this module.
 *
 * A recovered step runs this module again from the start. The sandbox makes
 * that safe: the submit is idempotent on `execId`, and the sandbox keeps the
 * record of each exec it ran, thus a second submit attaches to the running or
 * finished exec instead of a second run. The poll then starts at cursor 0, and
 * the caller gets the events of the exec again.
 */

import { DBOS, Error as DBOSErrors, StatusString } from "@dbos-inc/dbos-sdk";

import { untracedFetch } from "../lib/otel-spans.js";
import { EXEC_STREAM_BYTE_CAP } from "../tools/workspace/result-bounds.js";
import { createEscalationPolicy, probeLiveness, syntheticFailureReason, syntheticFailureResult } from "./liveness.js";
import { PollResponseSchema, type ExecEmit, type ExecRequest, type ExecResult, type SandboxLiveness, type SandboxRef, type SubmitExecBody } from "./types.js";

const SUBMIT_HTTP_TIMEOUT_MS = 30_000;
const POLL_HTTP_TIMEOUT_MS = 10_000;

/**
 * Two-phase poll cadence: 1.5 s for the first 40 polls (about the first minute
 * of the exec) keeps a short command prompt, and 10 s after that bounds the
 * request rate of an exec that runs for hours.
 */
const FAST_POLL_INTERVAL_MS = 1_500;
const FAST_POLL_ATTEMPTS = 40;
const SLOW_POLL_INTERVAL_MS = 10_000;

/**
 * The minimum gap between two reads of the workflow status. A step does not see
 * a cancel on its own, thus the exec reads the status of its workflow and stops
 * when the workflow is cancelled.
 */
const CANCEL_CHECK_INTERVAL_MS = 10_000;

export class ExecTimeoutError extends Error {
    readonly execId: string;
    constructor(execId: string) {
        super(`exec[${execId}]: deadline exceeded before a terminal result`);
        this.execId = execId;
    }
}

/** The effects of one exec. Each member has a default, and a test replaces it. */
export interface ExecDeps {
    /** Defaults to `globalThis.fetch`. */
    readonly fetch?: typeof fetch;
    /** The clock of the deadline and of the cancel reads. Defaults to `Date.now`. */
    readonly now?: () => number;
    /** The pause between two polls. Defaults to a timer. */
    readonly sleep?: (ms: number) => Promise<void>;
    /**
     * Sink for advisory warnings: events that the sandbox ring shed. Defaults to
     * `DBOS.logger.warn`. The terminal result, not the event stream, is the
     * outcome of the exec.
     */
    readonly warn?: (message: string) => void;
    /**
     * Backend inspect for the liveness escalation (`liveness.ts`). Absent, the
     * exec never probes and only the deadline bounds it. A throw is an
     * inconclusive probe, never a failed exec.
     */
    readonly isAlive?: (ref: SandboxRef) => Promise<SandboxLiveness>;
    /** True once the owning workflow is cancelled. Defaults to a read of the DBOS workflow status. */
    readonly isCancelled?: () => Promise<boolean>;
    /** Per-stream retention budget sent with the submit. Defaults to `EXEC_STREAM_BYTE_CAP`. */
    readonly execStreamByteCap?: number;
}

/**
 * The id of the exec that runs in the current durable step: the workflow id
 * and the function id of the step. Both are stable across a replay, and DBOS
 * makes the pair unique, thus no caller mints an exec id.
 */
export function stepExecId(): string {
    const workflowId = DBOS.workflowID;
    const stepId = DBOS.stepID;
    if (workflowId === undefined || stepId === undefined) {
        throw new Error("a sandbox exec runs inside a DBOS workflow, and none is active");
    }
    return `${workflowId}:${stepId}`;
}

/**
 * Run one exec to its terminal result.
 *
 * `deadlineMs` is an absolute unix-ms timestamp. A machine that the liveness
 * probe finds dead ends the exec with a synthetic-failure result. A cancel of
 * the owning workflow throws `DBOSWorkflowCancelledError`.
 */
export async function runExec(
    ref: SandboxRef,
    execId: string,
    request: ExecRequest,
    emit: ExecEmit,
    deadlineMs: number,
    deps: ExecDeps = {},
): Promise<ExecResult> {
    const fetchImpl = deps.fetch ?? fetch;
    const cap = deps.execStreamByteCap ?? EXEC_STREAM_BYTE_CAP;
    await submitExec(fetchImpl, ref, {
        command: [...request.command],
        execId,
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        ...(request.env === undefined ? {} : { env: { ...request.env } }),
        ...(request.timeoutSeconds === undefined ? {} : { timeoutSeconds: request.timeoutSeconds }),
        stdoutByteCap: cap,
        stderrByteCap: cap,
    });
    return pollExec(ref, execId, emit, deadlineMs, deps);
}

/**
 * POST the command to `/exec` and return after the 202 ack. A non-202 throws.
 * The server dedups on `execId`: a submit of an exec that it already holds
 * returns 202 with the stored status and runs nothing.
 */
async function submitExec(fetchImpl: typeof fetch, ref: SandboxRef, body: SubmitExecBody): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUBMIT_HTTP_TIMEOUT_MS);
    try {
        const res = await untracedFetch(fetchImpl, `http://${ref.host}:${ref.port}/exec`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        if (res.status !== 202) {
            const text = await res.text().catch(() => "");
            throw Object.assign(new Error(`submitExec: sandbox-server returned ${res.status} for execId=${body.execId}: ${text}`), { statusCode: res.status });
        }
        // Read and discard the ack, so the socket is released.
        await res.text().catch(() => "");
    } finally {
        clearTimeout(timer);
    }
}

/**
 * One poll of `GET /exec/{execId}?since={cursor}`.
 *
 * Never throws: a failed poll is not a failed exec, thus every failure is
 * `unavailable` and the loop keeps waiting (bounded by the deadline).
 */
type PolledSnapshot = { readonly kind: "ok"; readonly raw: string } | { readonly kind: "unavailable"; readonly detail: string };

async function pollOnce(fetchImpl: typeof fetch, ref: SandboxRef, execId: string, cursor: number): Promise<PolledSnapshot> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POLL_HTTP_TIMEOUT_MS);
    try {
        const res = await untracedFetch(fetchImpl, `http://${ref.host}:${ref.port}/exec/${encodeURIComponent(execId)}?since=${cursor}`, {
            method: "GET",
            signal: controller.signal,
        });
        if (!res.ok) {
            await res.text().catch(() => "");
            return { kind: "unavailable", detail: `status ${res.status}` };
        }
        return { kind: "ok", raw: await res.text() };
    } catch (cause) {
        return { kind: "unavailable", detail: cause instanceof Error ? cause.message : String(cause) };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Poll until the exec is terminal. Each poll reads
 * `{ status, events, cursor, result? }`, forwards the events past the local
 * cursor through `emit`, and returns `result` once it is there.
 *
 * Consecutive `unavailable` polls arm a backend probe (`liveness.ts`). Only an
 * observably dead machine fails the exec, because the result lives in that
 * machine and nowhere else.
 */
async function pollExec(ref: SandboxRef, execId: string, emit: ExecEmit, deadlineMs: number, deps: ExecDeps): Promise<ExecResult> {
    const fetchImpl = deps.fetch ?? fetch;
    const now = deps.now ?? Date.now;
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const warn = deps.warn ?? ((message: string) => DBOS.logger.warn(message));
    const isCancelled = deps.isCancelled ?? workflowCancelled;

    let cursor = 0;
    let pollAttempt = 0;
    let lastCancelCheckMs = now();
    const escalation = createEscalationPolicy();

    while (true) {
        pollAttempt += 1;
        const polled = await pollOnce(fetchImpl, ref, execId, cursor);

        if (polled.kind === "ok") {
            const resp = PollResponseSchema.parse(JSON.parse(polled.raw));
            // Each event is emitted at most once, whatever `since` the server applied.
            const newEvents = resp.events.filter((ev) => ev.seq > cursor);
            // Sequence numbers are contiguous per exec, thus a hole between the local
            // cursor and the next delivered (or high-water) seq proves that the ring
            // shed events before the host saw them.
            const nextSeq = newEvents.length > 0 ? newEvents[0]!.seq : resp.cursor > cursor ? resp.cursor + 1 : cursor + 1;
            const lost = nextSeq - cursor - 1;
            if (lost > 0) {
                warn(
                    `exec[${execId}]: ${lost} progress event(s) (seq ${cursor + 1}-${cursor + lost}) shed by the sandbox ring before delivery; the terminal result is unaffected`,
                );
            }
            // Forwarded before the return, thus trailing progress lands ahead of the result.
            for (const ev of newEvents) {
                await emit(ev.payload);
            }
            if (resp.cursor > cursor) cursor = resp.cursor;
            if (resp.result !== undefined) return resp.result;
        }

        if (deps.isAlive && escalation.onPoll(polled.kind === "ok" ? "ok" : "unavailable")) {
            const verdict = await probeLiveness(deps.isAlive, ref);
            // `alive` (a slow exec) and `inconclusive` (a backend
            // API error) both resume the poll, bounded by the deadline.
            if (verdict.kind === "dead") {
                return syntheticFailureResult(execId, syntheticFailureReason({ oomKilled: verdict.oomKilled }));
            }
        }

        // The deadline gate sits AFTER the poll, thus the loop always asks once more
        // before it declares a timeout: a missed poll window is not a slow command.
        const nowMs = now();
        const remainingMs = deadlineMs - nowMs;
        if (remainingMs <= 0) throw new ExecTimeoutError(execId);

        if (nowMs - lastCancelCheckMs >= CANCEL_CHECK_INTERVAL_MS) {
            lastCancelCheckMs = nowMs;
            if (await isCancelled()) throw new DBOSErrors.DBOSWorkflowCancelledError(DBOS.workflowID ?? execId);
        }

        const intervalMs = pollAttempt <= FAST_POLL_ATTEMPTS ? FAST_POLL_INTERVAL_MS : SLOW_POLL_INTERVAL_MS;
        await sleep(Math.min(intervalMs, remainingMs));
    }
}

/** Read the status of the workflow that runs this exec. Outside a workflow, nothing can cancel it. */
async function workflowCancelled(): Promise<boolean> {
    const workflowId = DBOS.workflowID;
    if (workflowId === undefined) return false;
    const status = await DBOS.getWorkflowStatus(workflowId);
    return status?.status === StatusString.CANCELLED;
}
