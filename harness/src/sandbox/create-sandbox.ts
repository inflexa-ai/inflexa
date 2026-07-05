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

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { V1Toleration } from "@kubernetes/client-node";
import type { Pool } from "pg";

import { clampResources, type ResourceLimits } from "../config/resource-limits.js";
import { tryMutation } from "../lib/db-result.js";
import { unwrapOrThrow } from "../lib/result.js";
import { clearSandboxRef, setSandboxRef } from "../state/index.js";
import { awaitExec, type AwaitExecOptions } from "./await-exec.js";
import type { SandboxClient } from "./client.js";
import { createDockerSandboxOps } from "./docker-client.js";
import { createK8sSandboxOps } from "./k8s-client.js";
import { STEP_SUBDIRS } from "./mount-plan.js";
import { submitExec, type SubmitExecDeps } from "./submit-exec.js";
import { toPersistedRef, type CreateSandboxMeta, type SandboxRef } from "./types.js";

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
    /** Default sandbox-base image when the workflow doesn't override per-step. */
    image: string;
    /** Cluster resource ceilings; every sandbox request is clamped to these. */
    resourceLimits: ResourceLimits;
    /** K8s namespace; only used by the k8s backend. */
    namespace?: string;
    /**
     * Session-tree root — dev host dir Docker binds, or the `cortex-sessions`
     * PVC mountpoint on the Cortex pod in prod. Always required: the writable
     * step dir is pre-created here regardless of backend.
     */
    sessionsBasePath: string;
    /** Docker: host dir bind-mounted read-only at `/mnt/libs`. */
    libStorePath?: string;
    /** Docker: host dir bind-mounted read-only at `/mnt/refs`. */
    refStorePath?: string;
    /** Docker: force the container platform (e.g. `linux/amd64`) so the sandbox matches the mounted lib store's arch. */
    platform?: string;
    /** K8s: PVC claim backing the session-tree volume. */
    sessionPvc?: string;
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
    /** Injectables for tests / non-production environments. */
    submitDeps?: SubmitExecDeps;
    awaitOptions?: AwaitExecOptions;
}

export function createSandboxClient(config: CreateSandboxClientConfig): SandboxClient {
    const backend = config.backend ?? config.env.backend;

    const registerSandbox = async (meta: CreateSandboxMeta, ref: SandboxRef) => {
        unwrapOrThrow(await setSandboxRef(config.pool, meta.runId, meta.stepId, toPersistedRef(ref), meta.execId ?? null));
    };

    const ops =
        backend === "k8s"
            ? createK8sSandboxOps({
                  image: config.image,
                  cortexBaseUrl: config.cortexBaseUrl,
                  namespace: config.namespace ?? config.env.namespace,
                  sessionPvc: config.sessionPvc,
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
                  sessionsBasePath: config.sessionsBasePath,
                  libStorePath: config.libStorePath,
                  refStorePath: config.refStorePath,
                  platform: config.platform,
                  registerSandbox,
              });

    // Backend-agnostic pre-creation of the writable step tree. In dev this is
    // the host dir Docker binds; in prod `sessionsBasePath` is the
    // `cortex-sessions` PVC mountpoint on the Cortex pod — the same volume the
    // sandbox pod mounts via subPath. mkdir(recursive) is idempotent, so an
    // existing tree (replay, retry) is not an error.
    const precreateStepTree = async (meta: CreateSandboxMeta): Promise<void> => {
        // A read-only sandbox has no writable step mount — nothing to pre-create.
        if (meta.readOnly) return;
        const stepDir = join(config.sessionsBasePath, meta.analysisId, "runs", meta.runId, meta.stepId);
        await mkdir(stepDir, { recursive: true });
        await Promise.all(STEP_SUBDIRS.map((sub) => mkdir(join(stepDir, sub), { recursive: true })));
    };

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

    return {
        createSandbox: async (meta, identity) => {
            await precreateStepTree(meta);
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
        awaitExec: (execId, secret, emit, deadline) => awaitExec(execId, secret, emit, deadline, config.awaitOptions),
        isAlive: async (ref) => unwrapOrThrow(await ops.isAlive(ref)),
        teardown,
        teardownById: async (sandboxId) => unwrapOrThrow(await ops.teardownById(sandboxId)),
        listManagedSandboxes: async () => unwrapOrThrow(await ops.listManagedSandboxes()),
    };
}

/** Re-exports so consumers import once from this module. */
export { clearSandboxRef };
