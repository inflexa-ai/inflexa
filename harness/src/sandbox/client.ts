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

import type {
    CreateSandboxMeta,
    ExecEmit,
    ExecResult,
    ManagedSandbox,
    SandboxIdentity,
    SandboxLiveness,
    SandboxRef,
    SandboxTransport,
    SubmitExecBody,
} from "./types.js";

export interface SandboxClient {
    /**
     * The result transport this client awaits under, fixed at construction. A caller that runs outside a
     * workflow body reads it: `callback` awaits through `DBOS.recv`, which is body-only, thus such a caller
     * must refuse before it starts a container it can never await.
     *
     * Optional, because a hand-written realization states nothing here. Absent means unknown, and a caller
     * treats it as the poll default rather than refusing every composition that omits it.
     */
    readonly transport?: SandboxTransport;

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
     * Awaits a submitted exec's terminal result under the client's transport.
     * Poll (default) loops durable, signed `GET /exec/{execId}?since={cursor}`
     * steps against the sandbox in `ref`; callback loops
     * `DBOS.recv("exec-event:${execId}", T)` with a signed pull as its
     * recovery backstop. Both HMAC-verify every body against
     * `ref.callbackSecret`, forward progress events via `emit`, and are
     * bounded by `deadline` (absolute unix-ms timestamp).
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
     * Liveness by id alone — the reaper path (see the harness-sandbox-exec spec),
     * which holds a `sandboxId` from the cluster sweep but no full `SandboxRef`.
     * Same semantics and the same throwing contract as {@link SandboxClient.isAlive},
     * which delegates to it.
     */
    isAliveById(sandboxId: string): Promise<SandboxLiveness>;

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
