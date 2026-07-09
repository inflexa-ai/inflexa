/**
 * `submitExec` — backend-agnostic DBOS step that POSTs a command to
 * sandbox-server's `/exec` and returns after the HTTP 202 ack (ADR
 * 0002). `submitExec` wraps its own POST in a `DBOS.runStep` keyed
 * `sandbox.submit-exec.${execId}`.
 *
 * Step name: `sandbox.submit-exec.${execId}` — `execId` is already unique
 * across the workflow (`${workflowId}:${stepId}:${functionId}`), so it
 * doubles as the DBOS step replay cache key. On replay the cached step
 * output is returned without re-POSTing; any duplicate POST that
 * actually reaches sandbox-server during a narrow in-flight window is
 * deduped server-side (PR #3 change 4) on the same `execId`.
 *
 * A non-202 status throws — the step boundary is throw-based by design
 * (the `resultStep` principle): durability records a step as failed only
 * on a thrown exception, and a throw lets DBOS cancellation propagate
 * untouched.
 */

import { DBOS } from "@dbos-inc/dbos-sdk";

import { signCallback } from "./hmac.js";
import type { SandboxRef, SubmitExecBody } from "./types.js";

export interface SubmitExecDeps {
    /** Injected for tests. Defaults to `globalThis.fetch`. */
    fetch?: typeof fetch;
    /** Injected for tests. Defaults to `DBOS.runStep`. */
    runStep?: <T>(fn: () => Promise<T>, config: { name: string }) => Promise<T>;
}

const SUBMIT_HTTP_TIMEOUT_MS = 30_000;

async function postExec(fetchImpl: typeof fetch, ref: SandboxRef, body: SubmitExecBody): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUBMIT_HTTP_TIMEOUT_MS);
    try {
        // Sign the exact bytes we send, over the same HMAC construction the
        // sandbox uses for its callbacks — sandbox-server authenticates every
        // inbound request. `Date.now()` is safe here: this whole POST runs inside
        // a `DBOS.runStep` whose cached result is replayed without re-executing
        // the body, so the timestamp never re-computes on recovery.
        const raw = JSON.stringify(body);
        const timestamp = Math.floor(Date.now() / 1000);
        const signature = signCallback({ execId: body.execId, body: raw, timestamp, secret: ref.callbackSecret });
        const res = await fetchImpl(`http://${ref.host}:${ref.port}/exec`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-sandbox-signature": signature,
                "x-sandbox-timestamp": String(timestamp),
            },
            body: raw,
            signal: controller.signal,
        });

        if (res.status !== 202) {
            const text = await res.text().catch(() => "");
            throw Object.assign(new Error(`submitExec: sandbox-server returned ${res.status} for execId=${body.execId}: ${text}`), { statusCode: res.status });
        }
        // The 202 body carries either `{ status: "started" }` (fresh) or a
        // dedup-hit summary. Both are success — read and discard so the
        // socket is released.
        await res.text().catch(() => "");
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Submit an exec as a DBOS step. The step name is unique per execId, so
 * a workflow that has already submitted the exec replays without issuing
 * another POST.
 */
export async function submitExec(ref: SandboxRef, body: SubmitExecBody, deps: SubmitExecDeps = {}): Promise<void> {
    const fetchImpl = deps.fetch ?? fetch;
    const runStep = deps.runStep ?? (<T>(fn: () => Promise<T>, c: { name: string }) => DBOS.runStep(fn, c));

    await runStep(() => postExec(fetchImpl, ref, body), {
        name: `sandbox.submit-exec.${body.execId}`,
    });
}
