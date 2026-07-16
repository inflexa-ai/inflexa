/**
 * Backend-selected `SandboxClient` factory.
 *
 * Docker for local dev, K8s for production — the single place the
 * `SANDBOX_BACKEND` env decision lives. Injected at the composition root
 * as a construction-time dependency (see the harness-durable-runtime spec); callers do NOT import a
 * backend module directly.
 *
 * Registry write/clear callbacks are wired here so the per-backend
 * `createSandbox` / `teardown` implementations stay free of state-layer
 * coupling (they just call the closures we hand them). `submitExec` and
 * `awaitExec` are backend-agnostic — they only need the SandboxRef.
 */

import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { V1Toleration } from "@kubernetes/client-node";
import type { Pool } from "pg";

import type { Logger } from "../lib/logger.js";
import { clampResources, type ResourceLimits } from "../config/resource-limits.js";
import { stepWritePrefix, type ResolveWorkspaceRoot } from "../workspace/paths.js";
import { tryMutation } from "../lib/db-result.js";
import { unwrapOrThrow } from "../lib/result.js";
import { clearSandboxRef, setSandboxRef } from "../state/index.js";
import { awaitExec, type AwaitExecOptions } from "./await-exec.js";
import type { SandboxClient } from "./client.js";
import { createDockerSandboxOps } from "./docker-client.js";
import { createK8sSandboxOps } from "./k8s-client.js";
import { STEP_SUBDIRS } from "./mount-plan.js";
import { submitExec, type SubmitExecDeps } from "./submit-exec.js";
import { toPersistedRef, type CreateSandboxMeta, type SandboxRef, type SandboxTransport } from "./types.js";

/**
 * Narrow config slice the sandbox factory reads off `Env` — the backend
 * default and the K8s namespace fallback. Composition roots map their
 * validated `Env` onto this.
 */
export interface SandboxBackendConfig {
    readonly backend: "docker" | "k8s";
    readonly namespace: string;
}

export interface CreateSandboxClientConfig {
    /** App pool — used for registry writes inside the create/teardown steps. */
    pool: Pool;
    /** Backend default + namespace fallback source. */
    env: SandboxBackendConfig;
    /** Cortex base URL injected into sandbox-server's env for callbacks. */
    cortexBaseUrl: string;
    /**
     * Result transport for every sandbox this client creates. Threaded to the
     * container as `SANDBOX_TRANSPORT` and to `awaitExec`'s loop selection.
     * Defaults to `poll`.
     */
    transport?: SandboxTransport;
    /** Default sandbox-base image when the workflow doesn't override per-step. */
    image: string;
    /** Cluster resource ceilings; every sandbox request is clamped to these. */
    resourceLimits: ResourceLimits;
    /** K8s namespace; only used by the k8s backend. */
    namespace?: string;
    /**
     * Workspace-root resolution seam (see workspace/paths.ts). Docker binds
     * each analysis's resolved root; on K8s the resolved roots live under the
     * session PVC. Always required: the writable step dir is pre-created under
     * the resolved root regardless of backend.
     */
    resolveWorkspaceRoot: ResolveWorkspaceRoot;
    /** Docker: host dir bind-mounted read-only at `/mnt/libs`. */
    libStorePath?: string;
    /** Docker: host dir bind-mounted read-only at `/mnt/refs`. */
    refStorePath?: string;
    /** Docker: force the container platform (e.g. `linux/amd64`) so the sandbox matches the mounted lib store's arch. */
    platform?: string;
    /**
     * Docker: unix socket of the Docker-API engine to dial — a Docker daemon
     * socket or a podman Docker-compat socket. Unset preserves dockerode's
     * default resolution (`DOCKER_HOST`, then the default Docker socket).
     */
    engineSocketPath?: string;
    /**
     * Docker: how the pre-created step write tree is made writable by the
     * uid-1000 sandbox workload. `world-writable` chmods the step dir and its
     * subdirs so a workload write lands through engines whose bind mounts
     * preserve host ownership honestly — podman machine's virtiofs presents the
     * embedder user's real uid and modes, which the uid-1000 workload cannot
     * write. Docker Desktop's file-sharing layer masks that mismatch, so it
     * stays unset there. A single-valued union (not a boolean) so the call site
     * reads as policy and future strategies extend it without a breaking change.
     */
    stepTreeAccess?: "world-writable";
    /** K8s: PVC claim backing the session PVC the workspace roots live under. */
    sessionPvc?: string;
    /**
     * K8s: absolute mountpoint of `sessionPvc` on this process's filesystem. Required with
     * `sessionPvc` — the pod's `subPath` is a resolved workspace root taken relative to it,
     * which is what keeps the pre-created step tree and the mounted step tree the same one.
     */
    sessionPvcRoot?: string;
    /** K8s: PVC claim mounted read-only at `/mnt/libs`. */
    libStorePvc?: string;
    /** K8s: PVC claim mounted read-only at `/mnt/refs`. */
    refStorePvc?: string;
    /** K8s: node selector pinning sandbox pods to the dedicated agent pool. */
    nodeSelector?: Record<string, string>;
    /** K8s: tolerations letting sandbox pods land on the tainted agent nodes. */
    tolerations?: V1Toleration[];
    /** K8s: RuntimeClass for runtime isolation (e.g. `gvisor`). */
    runtimeClassName?: string;
    /** Override the backend selection — defaults to `env.SANDBOX_BACKEND`. */
    backend?: "docker" | "k8s";
    /**
     * Optional logger forwarded to the Docker backend so a lib-store degradation
     * (a configured store whose `current` vanished/went incomplete mid-session) is
     * observable rather than a silent mount drop. No-op when unset.
     */
    logger?: Logger;
    /** Dependency seams (fetch, durable step/sleep, clock, recv, warn sink) forwarded to submit/await. */
    submitDeps?: SubmitExecDeps;
    awaitOptions?: AwaitExecOptions;
}

/**
 * Assemble `awaitExec`'s options: the liveness probe self-wires from the
 * backend ops (the poll loop's escalation always has its arbiter under the
 * client), explicit seam injections in `base` win over the self-wired probe,
 * and the transport is client-owned — never overridable through the seam bag.
 * Exported for tests.
 */
export function composeAwaitOptions(
    base: AwaitExecOptions | undefined,
    transport: SandboxTransport,
    isAlive: NonNullable<AwaitExecOptions["isAlive"]>,
): AwaitExecOptions {
    return { isAlive, ...base, transport };
}

/**
 * Backend-agnostic pre-creation of the writable step tree under the analysis's
 * resolved workspace root. On Docker that root is the host dir the container
 * binds; on K8s it lives under the session PVC the sandbox pod mounts via
 * subPath. `mkdir(recursive)` is idempotent, so an existing tree (replay, retry)
 * is not an error. A read-only sandbox has no writable step mount, so there is
 * nothing to pre-create.
 *
 * `stepTreeAccess: "world-writable"` chmods the step dir and each subdir so the
 * uid-1000 sandbox workload can write them through engines that honor host bind
 * ownership. The chmod is explicit, not `mkdir`'s `mode` option: the process
 * umask masks `mkdir`'s mode, and on replay the dirs already exist so `mkdir`
 * would not touch them either way. Scoped to the step write tree — the
 * read-only mount sources are never re-moded. Exported for tests.
 */
export async function precreateStepTree(
    deps: { resolveWorkspaceRoot: ResolveWorkspaceRoot; stepTreeAccess?: "world-writable" },
    meta: CreateSandboxMeta,
): Promise<void> {
    if (meta.readOnly) return;
    const stepDir = stepWritePrefix({
        workspaceRoot: deps.resolveWorkspaceRoot(meta.analysisId),
        runId: meta.runId,
        stepId: meta.stepId,
    });
    await mkdir(stepDir, { recursive: true });
    await Promise.all(STEP_SUBDIRS.map((sub) => mkdir(join(stepDir, sub), { recursive: true })));
    if (deps.stepTreeAccess === "world-writable") {
        await chmod(stepDir, 0o777);
        await Promise.all(STEP_SUBDIRS.map((sub) => chmod(join(stepDir, sub), 0o777)));
    }
}

export function createSandboxClient(config: CreateSandboxClientConfig): SandboxClient {
    const backend = config.backend ?? config.env.backend;
    const transport = config.transport ?? "poll";

    const registerSandbox = async (meta: CreateSandboxMeta, ref: SandboxRef) => {
        unwrapOrThrow(await setSandboxRef(config.pool, meta.runId, meta.stepId, toPersistedRef(ref), meta.execId ?? null));
    };

    const ops =
        backend === "k8s"
            ? createK8sSandboxOps({
                  image: config.image,
                  cortexBaseUrl: config.cortexBaseUrl,
                  transport,
                  namespace: config.namespace ?? config.env.namespace,
                  sessionPvc: config.sessionPvc,
                  sessionPvcRoot: config.sessionPvcRoot,
                  resolveWorkspaceRoot: config.resolveWorkspaceRoot,
                  libStorePvc: config.libStorePvc,
                  refStorePvc: config.refStorePvc,
                  nodeSelector: config.nodeSelector,
                  tolerations: config.tolerations,
                  runtimeClassName: config.runtimeClassName,
                  registerSandbox,
              })
            : createDockerSandboxOps({
                  image: config.image,
                  cortexBaseUrl: config.cortexBaseUrl,
                  transport,
                  resolveWorkspaceRoot: config.resolveWorkspaceRoot,
                  libStorePath: config.libStorePath,
                  refStorePath: config.refStorePath,
                  platform: config.platform,
                  engineSocketPath: config.engineSocketPath,
                  logger: config.logger,
                  registerSandbox,
              });

    // `teardown` needs the registry-clear closure but the SandboxRef alone
    // doesn't carry runId/stepId. Wrap the backend impl so callers pass the
    // ref + step coordinates and the wrapper does the clear after the
    // backend-level removal.
    const teardown = async (ref: SandboxRef): Promise<void> => {
        unwrapOrThrow(await ops.teardown(ref));
        // Sandboxes are 1-per-step (see `sandbox-step.ts` body — each child
        // workflow calls `createSandbox` once then `teardown` once), so the
        // broad WHERE clause matches exactly one row. If that invariant ever
        // changes (e.g. a step reuses a sibling's sandbox), this clear must
        // be scoped to (run, step) to avoid wiping prior steps' provenance.
        unwrapOrThrow(
            await tryMutation("createSandbox.teardownClearSandboxRef", async () => {
                await config.pool.query({
                    text: `UPDATE cortex_step_executions
            SET sandbox_ref = NULL, exec_id = NULL
            WHERE sandbox_ref->>'sandboxId' = $1`,
                    values: [ref.sandboxId],
                });
            }),
        );
    };

    // One arbiter for both surfaces: the client's `isAlive` method and the
    // poll loop's escalation probe are the same backend inspect.
    const isAlive = async (ref: SandboxRef) => unwrapOrThrow(await ops.isAlive(ref));

    return {
        createSandbox: async (meta, identity) => {
            await precreateStepTree({ resolveWorkspaceRoot: config.resolveWorkspaceRoot, stepTreeAccess: config.stepTreeAccess }, meta);
            // Every caller must declare resources — a sandbox with no cpu/memory
            // request is a semantic error, not something to paper over with a
            // default (a DBOS replay of a pre-resources workflow input lands here).
            if (!meta.resources) {
                throw new Error(`createSandbox: ${meta.analysisId}/${meta.runId}/${meta.stepId} has no resources — every caller must declare cpu/memoryGb`);
            }
            // Clamp to cluster ceilings so the pod is always quota-admissible.
            const resources = clampResources(meta.resources, config.resourceLimits);
            return unwrapOrThrow(await ops.createSandbox({ ...meta, resources }, identity));
        },
        submitExec: async (ref, body) => submitExec(ref, body, config.submitDeps),
        awaitExec: (ref, execId, emit, deadline) => awaitExec(ref, execId, emit, deadline, composeAwaitOptions(config.awaitOptions, transport, isAlive)),
        isAlive,
        teardown,
        teardownById: async (sandboxId) => unwrapOrThrow(await ops.teardownById(sandboxId)),
        listManagedSandboxes: async () => unwrapOrThrow(await ops.listManagedSandboxes()),
    };
}

/** Re-exports so consumers import once from this module. */
export { clearSandboxRef };
