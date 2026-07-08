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
 *
 * ## Recv is not the only way home
 *
 * The completion callback is a *push* to an address baked into the container at
 * creation. A host that dies mid-exec comes back with a different ingress port,
 * so the push can never land — the sandbox retries into a void while the
 * recovered recv waits for a message that will never arrive. That is the
 * recovery wedge (#41), and it is silent: a `running` row that never advances.
 *
 * So whenever the topic falls quiet, this loop stops waiting and *asks*:
 * `GET /exec/{execId}` on the sandbox itself returns the terminal result,
 * signed fresh at request time. The bytes are the ones the callback would have
 * carried, so the provenance frame survives the recovery path intact and one
 * verification path serves both. Push remains the fast path; pull is what makes
 * the protocol durable rather than merely optimistic.
 *
 * The pull is a DBOS step, not a bare `fetch`: a body-level call whose result
 * varied between replays would desynchronise the recorded function-ID sequence.
 */

import { DBOS } from "@dbos-inc/dbos-sdk";

import { signCallback, verifyCallback } from "./hmac.js";
import { ExecResultSchema, isDoneMarker, isSyntheticFailure, type ExecEmit, type ExecEventMessage, type ExecResult, type SandboxRef } from "./types.js";

const DEFAULT_FRESHNESS_SECONDS = 300;
const MAX_RECV_TIMEOUT_SECONDS = 5;

/**
 * Silent recv slices to tolerate before pulling. At `MAX_RECV_TIMEOUT_SECONDS`
 * per slice this is ~30s of silence — long enough that a chatty exec never
 * pulls at all, short enough that a recovered workflow converges quickly. Each
 * pull is a durable step, so polling every slice would write a step row every
 * five seconds for the life of a quiet three-hour exec.
 */
const PULL_AFTER_SILENT_SLICES = 6;

const PULL_HTTP_TIMEOUT_MS = 10_000;

/**
 * What `GET /exec/{execId}` told us.
 *
 * `running` and `unavailable` are both "keep waiting" — they differ only in
 * what gets logged. `unavailable` covers a sandbox that is unreachable, an
 * execId the sandbox has evicted (its table keeps terminal entries for an
 * hour), and any non-200: none of these are failures of the exec itself, and
 * the deadline plus the liveness watchdog still bound the loop.
 */
type PulledCompletion =
    | { readonly kind: "completed"; readonly raw: string; readonly signature: string | null; readonly timestamp: number | null }
    | { readonly kind: "running" }
    | { readonly kind: "unavailable"; readonly detail: string };

/**
 * Fetch the terminal result for `execId` directly from sandbox-server.
 *
 * Never throws: every failure mode collapses to `unavailable`, because a failed
 * pull is not a failed exec. Returning an error here would fail the enclosing
 * DBOS step and take the workflow with it, when the correct response is simply
 * to keep waiting for the push.
 *
 * A terminal response is distinguished by the presence of the signature header
 * — sandbox-server leaves a still-running exec unsigned, having nothing to
 * attest to yet.
 */
async function pullExecResult(fetchImpl: typeof fetch, ref: SandboxRef, execId: string): Promise<PulledCompletion> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PULL_HTTP_TIMEOUT_MS);
    try {
        // The result discloses the command's output, so sandbox-server requires a
        // signed request. Sign an empty body over the same construction as the
        // callbacks. `Date.now()` is safe: this runs inside a `DBOS.runStep` whose
        // cached result is replayed without re-executing the body.
        const reqTimestamp = Math.floor(Date.now() / 1000);
        const reqSignature = signCallback({ execId, body: "", timestamp: reqTimestamp, secret: ref.callbackSecret });
        const res = await fetchImpl(`http://${ref.host}:${ref.port}/exec/${encodeURIComponent(execId)}`, {
            method: "GET",
            headers: {
                "x-sandbox-signature": reqSignature,
                "x-sandbox-timestamp": String(reqTimestamp),
            },
            signal: controller.signal,
        });
        if (!res.ok) {
            await res.text().catch(() => "");
            return { kind: "unavailable", detail: `status ${res.status}` };
        }

        const signature = res.headers.get("x-sandbox-signature");
        const raw = await res.text();
        if (signature === null) return { kind: "running" };

        const tsHeader = res.headers.get("x-sandbox-timestamp");
        const parsedTs = tsHeader === null ? null : Number.parseInt(tsHeader, 10);
        return {
            kind: "completed",
            raw,
            signature,
            // An unparseable timestamp forwards as null so `verifyCallback`
            // reports `missing` rather than us guessing a wall-clock.
            timestamp: parsedTs === null || Number.isNaN(parsedTs) ? null : parsedTs,
        };
    } catch (cause) {
        return { kind: "unavailable", detail: cause instanceof Error ? cause.message : String(cause) };
    } finally {
        clearTimeout(timer);
    }
}

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
    /** Injected for tests. Defaults to `globalThis.fetch`. */
    fetch?: typeof fetch;
    /** Injected for tests. Defaults to `DBOS.runStep`. */
    runStep?: <T>(fn: () => Promise<T>, config: { name: string }) => Promise<T>;
    /** Silent recv slices before the loop pulls. Defaults to {@link PULL_AFTER_SILENT_SLICES}. */
    pullAfterSilentSlices?: number;
}

/**
 * Body of the recv loop. Hoisted so it's testable without spinning up
 * DBOS — `recv` is injectable and `now` is overridable.
 */
export async function awaitExec(ref: SandboxRef, execId: string, emit: ExecEmit, deadlineMs: number, options: AwaitExecOptions = {}): Promise<ExecResult> {
    const topic = `exec-event:${execId}`;
    const callbackSecret = ref.callbackSecret;
    const freshnessSec = options.freshnessSec ?? DEFAULT_FRESHNESS_SECONDS;
    const now = options.now ?? (() => DBOS.now());
    const recv = options.recv ?? (async <T>(t: string, sec: number) => DBOS.recv<T>(t, sec));
    const fetchImpl = options.fetch ?? fetch;
    const runStep = options.runStep ?? (<T>(fn: () => Promise<T>, c: { name: string }) => DBOS.runStep(fn, c));
    const pullAfterSilentSlices = options.pullAfterSilentSlices ?? PULL_AFTER_SILENT_SLICES;

    // Both counters are pure functions of the checkpointed recv sequence, so a
    // replay issues exactly the same pulls in exactly the same order — which is
    // what keeps the DBOS function-ID sequence stable.
    let silentSlices = 0;
    let pullAttempt = 0;

    /** Ask the sandbox directly. Returns null when the exec has not finished. */
    const pull = async (): Promise<ExecResult | null> => {
        pullAttempt += 1;
        const pulled = await runStep(() => pullExecResult(fetchImpl, ref, execId), {
            name: `sandbox.pull-exec-result.${execId}.${pullAttempt}`,
        });
        if (pulled.kind !== "completed") return null;

        // Identical treatment to a pushed completion: the bytes were signed by
        // the same secret, so a forgery is as fatal here as it is there.
        const verified = verifyCallback({
            execId,
            body: Buffer.from(pulled.raw, "utf8"),
            signature: pulled.signature,
            timestamp: pulled.timestamp,
            secret: callbackSecret,
            nowSec: Math.floor((await now()) / 1000),
            freshnessSec,
        });
        if (!verified.valid) {
            throw new HardCancelError(execId, verified.reason, "pulled result");
        }
        return ExecResultSchema.parse(JSON.parse(pulled.raw));
    };

    while (true) {
        const remainingMs = deadlineMs - (await now());
        if (remainingMs <= 0) {
            // A lost callback is not a slow command. Ask once before declaring a
            // timeout — the result may have been sitting in the sandbox the whole
            // time, and reporting a timeout would discard a completed analysis.
            const pulled = await pull();
            if (pulled !== null) return pulled;
            throw new ExecTimeoutError(execId);
        }
        const timeoutSec = Math.min(MAX_RECV_TIMEOUT_SECONDS, Math.max(1, Math.ceil(remainingMs / 1000)));

        const msg = await recv<ExecEventMessage>(topic, timeoutSec);
        if (msg === null) {
            silentSlices += 1;
            if (silentSlices >= pullAfterSilentSlices) {
                silentSlices = 0;
                const pulled = await pull();
                if (pulled !== null) return pulled;
            }
            continue;
        }
        silentSlices = 0;

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
