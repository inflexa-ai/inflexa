/**
 * `SandboxClient` — the seam every sandbox-backed module in
 * the harness sits on. Implementations are backend-selected
 * (`docker`/`k8s`) by `createSandboxClient()` in `create-sandbox.ts` and
 * injected at the composition root as a construction-time dependency
 * (see the harness-durable-runtime spec). Callers do NOT import a backend module directly.
 *
 * The interface is split across three files:
 * - `client.ts` (here) — the interface and the per-method types.
 * - `create-sandbox.ts` — the factory + per-backend `createSandbox` /
 *   `teardown` / `isAlive` implementations.
 * - `exec.ts` — the submit and the poll loop of one exec, which are
 *   backend-agnostic (HTTP only).
 *
 * Lifetime separation (CONTEXT.md "Sandbox exec"):
 * - The **sandbox machine** lifetime is `createSandbox → ... → teardown`.
 *   Many execs may fire against the same machine.
 * - The **exec** lifetime is one `exec` call: one durable step.
 */

import type { ResultAsync } from "neverthrow";

import type { SpawnSession } from "../auth/types.js";
import type { SandboxError } from "./sandbox-error.js";
import type { ExecEmit, ExecRequest, ExecResult, ManagedSandbox, SandboxIdentity, SandboxLiveness, SandboxRef, SandboxSpec, ToolchainSource } from "./types.js";

export interface SandboxClient {
    /**
     * The declared owner of the sandbox toolchain, as the client was composed
     * with it: `"image"` when the config declared it, `"store"` when the config
     * declared nothing. The mount plan and the orient-core prompt both key on
     * this one value, thus the environment a sandbox gets and the text that
     * describes it cannot disagree. Required rather than optional, because an
     * optional field would carry two meanings, undeclared and unknown.
     */
    readonly toolchainSource: ToolchainSource;

    /**
     * DBOS step (`sandbox.create`) — the spawn half of the two-step create
     * (see the harness-sandbox-exec spec). Launches the sandbox-base container/Job under the
     * pre-minted `identity` (name + HMAC secret checkpointed by `sandbox.mint`),
     * stamps the labels, waits for `/health`, records the live handle in
     * the active-sandbox registry, and returns the in-memory `SandboxRef`. A
     * recovery re-run whose machine already exists (the crash window between
     * spawn and checkpoint) **adopts** it rather than leaking a second one.
     *
     * Each spawn failure is an `err` value, the refusal of the label hook
     * (`labels_refused`) included: a spawn path splits the result with
     * `keepSuspendingRefusal`. Only a defect of the deployment config, or a
     * throw of the workspace-root resolver, throws, and it fails the workflow.
     */
    createSandbox(session: SpawnSession, spec: SandboxSpec, identity: SandboxIdentity): ResultAsync<SandboxRef, SandboxError>;

    /**
     * DBOS step (`sandbox.exec`). Submits the command to the sandbox in `ref`,
     * polls the signed `GET /exec/{execId}?since={cursor}` until the exec is
     * terminal, forwards each progress event through `emit`, and returns the
     * result. `deadline` is an absolute unix-ms timestamp.
     *
     * The exec id is the id of the workflow and the function id of the step
     * that the exec runs in. Called from a workflow body, the exec is its own
     * step. Called inside a step (a tool call of the agent loop), it runs
     * inline in that step, thus ONE exec for each step: a second exec in the
     * same step gets the same id, and the sandbox gives it the result of the
     * first. Outside a workflow it throws.
     *
     * A recovered step submits again under the same id. The sandbox dedups the
     * submit on the id, thus the poll attaches to the exec that already ran or
     * runs, and `emit` sees its events again from the start.
     */
    exec(ref: SandboxRef, request: ExecRequest, emit: ExecEmit, deadline: number): Promise<ExecResult>;

    /**
     * Per-sandbox-machine liveness. `alive: false` only when observably dead
     * (terminal pod phase, missing container); `oomKilled` marks a death the
     * backend attributes to the machine's memory limit. Transient API errors
     * throw, so callers can decide whether to retry — a false `dead` verdict
     * would fail an exec that still runs.
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
