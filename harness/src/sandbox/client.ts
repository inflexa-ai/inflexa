/**
 * `SandboxClient` — the five-method seam every sandbox-backed module in
 * the harness sits on. Implementations are backend-selected
 * (`docker`/`k8s`) by `createSandboxClient()` in `create-sandbox.ts` and
 * injected at the composition root as a construction-time dependency
 * (see the harness-durable-runtime spec). Callers do NOT import a backend module directly.
 *
 * The interface is split across three files:
 * - `client.ts` (here) — the interface and the per-method types.
 * - `create-sandbox.ts` — the factory + per-backend `createSandbox` /
 *   `teardown` / `isAlive` implementations.
 * - `submit-exec.ts` + `await-exec.ts` — `submitExec` and the workflow-
 *   body recv loop, which are backend-agnostic (HTTP + DBOS messages).
 *
 * Lifetime separation (CONTEXT.md "Sandbox exec"):
 * - The **sandbox machine** lifetime is `createSandbox → ... → teardown`.
 *   Many execs may fire against the same machine.
 * - The **exec** lifetime is one `submitExec → awaitExec`.
 *
 * `awaitExec` runs in the workflow body (not as a DBOS step) because
 * `DBOS.recv` and `DBOS.writeStream` are body-only.
 */

import type { CreateSandboxMeta, ExecEmit, ExecResult, ManagedSandbox, SandboxIdentity, SandboxLiveness, SandboxRef, SubmitExecBody } from "./types.js";

export interface SandboxClient {
    /**
     * DBOS step (`sandbox.create`) — the spawn half of the two-step create
     * (see the harness-sandbox-exec spec). Launches the sandbox-base container/Job under the
     * pre-minted `identity` (name + HMAC secret checkpointed by `sandbox.mint`),
     * stamps ownership labels, waits for `/health`, records the live handle in
     * the active-sandbox registry, and returns the in-memory `SandboxRef`. A
     * recovery re-run whose machine already exists (the crash window between
     * spawn and checkpoint) **adopts** it rather than leaking a second one.
     */
    createSandbox(meta: CreateSandboxMeta, identity: SandboxIdentity): Promise<SandboxRef>;

    /**
     * DBOS step (`sandbox.submit-exec.${execId}`). POSTs the command to
     * sandbox-server's `/exec` and returns after the HTTP 202 ack. Does NOT
     * wait for command completion. Replay-safe: the cached step output is
     * returned on subsequent invocations; any duplicate POST that reaches
     * sandbox-server during the in-flight window is deduped server-side
     * (PR #3 change 4) on `execId`.
     */
    submitExec(ref: SandboxRef, body: SubmitExecBody): Promise<void>;

    /**
     * Workflow-body recv loop. Loops `DBOS.recv("exec-event:${execId}",
     * T)`, HMAC-verifies each message against `ref.callbackSecret`, forwards
     * meaningful events via `emit`, and returns the final `ExecResult` when
     * a done-marker arrives. Bounded by `deadline` (absolute unix-ms
     * timestamp); `T` is liveness-agnostic pacing only.
     *
     * Takes the whole `ref` rather than just the secret because a quiet topic
     * makes it pull the result from the sandbox directly — the recovery path
     * that stops a lost callback from wedging the run.
     */
    awaitExec(ref: SandboxRef, execId: string, emit: ExecEmit, deadline: number): Promise<ExecResult>;

    /**
     * Per-sandbox-machine liveness. `alive: false` only when observably dead
     * (terminal pod phase, missing container); `oomKilled` marks a death the
     * backend attributes to the machine's memory limit. Transient API errors
     * throw, so callers can decide whether to retry — silently lying about
     * dead sandboxes would race the synthetic-complete path.
     */
    isAlive(ref: SandboxRef): Promise<SandboxLiveness>;

    /**
     * DBOS step (`sandbox.teardown`). Deletes the K8s Job / removes the
     * Docker container, clears the active-sandbox registry. Idempotent —
     * "already gone" is a successful teardown.
     */
    teardown(ref: SandboxRef): Promise<void>;

    /**
     * Delete a sandbox machine by id alone — the reaper path (see the harness-sandbox-exec spec), which
     * holds a `sandboxId` from the cluster sweep but no full `SandboxRef`.
     * Does NOT touch the registry; the reaper reconciles the row itself.
     * Idempotent: "already gone" is success.
     */
    teardownById(sandboxId: string): Promise<void>;

    /**
     * Enumerate every Cortex-managed sandbox machine the backend is running,
     * scoped to the configured namespace (`app.kubernetes.io/managed-by=cortex`).
     * The cluster→registry direction the reaper needs — every other op takes a
     * ref the caller already holds; this one finds machines Cortex has forgotten.
     */
    listManagedSandboxes(): Promise<ManagedSandbox[]>;
}
