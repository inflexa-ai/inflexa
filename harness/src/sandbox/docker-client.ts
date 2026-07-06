/**
 * Docker-backed `createSandbox` / `teardown` / `isAlive`.
 *
 * Thin wrapper around `dockerode`. Storage is wired via `HostConfig.Binds`:
 * a flat read-only mount of the analysis tree at `/{resourceId}`, a nested
 * read-write mount of the step's artifact dir, and the lib/ref stores at
 * `/mnt/libs` / `/mnt/refs` when their host paths are configured. Container
 * paths and lib-store env come from the shared mount plan (`mount-plan.ts`).
 *
 * The container is launched with `CORTEX_BASE_URL` and
 * `SANDBOX_CALLBACK_SECRET` env so sandbox-server's outbound callback
 * client can sign and POST events back.
 */

import { join } from "node:path";
import Docker from "dockerode";
import { ResultAsync, err, ok } from "neverthrow";

import { type SandboxError, trySandbox } from "./sandbox-error.js";
import { buildMountPlan } from "./mount-plan.js";

/** Read the originating HTTP status off any `SandboxError` variant that carries one. */
function statusOf(e: SandboxError): number | undefined {
    return "status" in e ? e.status : undefined;
}
import type { CreateSandboxMeta, ManagedSandbox, SandboxIdentity, SandboxLiveness, SandboxRef } from "./types.js";

const SANDBOX_SERVER_PORT = 8765;
const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_MS = 250;

const MANAGED_BY_LABEL = "app.kubernetes.io/managed-by";
const MANAGED_BY_VALUE = "cortex";
const OWNER_WORKFLOW_LABEL = "cortex/owner-workflow-id";
const RUN_ID_LABEL = "cortex/run-id";
const STEP_ID_LABEL = "cortex/step-id";

export interface DockerClientConfig {
    image: string;
    /** Cortex base URL injected into the sandbox env so callbacks land here. */
    cortexBaseUrl: string;
    /** Host session-tree root; bind source for the analysis-tree mounts. */
    sessionsBasePath: string;
    /** Host lib store; bind-mounted read-only at `/mnt/libs` when set. */
    libStorePath?: string;
    /** Host ref store; bind-mounted read-only at `/mnt/refs` when set. */
    refStorePath?: string;
    /** Injected for tests. */
    docker?: Docker;
    /** Injected for tests so `/health` polling can be stubbed. */
    fetch?: typeof fetch;
    /** Hook called after the registry row is written. */
    registerSandbox: (meta: CreateSandboxMeta, ref: SandboxRef) => Promise<void>;
}

async function pollHealth(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
        try {
            const res = await fetchImpl(url);
            if (res.status === 200) return;
            lastErr = new Error(`/health returned ${res.status}`);
        } catch (err) {
            lastErr = err;
        }
        await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
    }
    throw new Error(`sandbox /health did not return 200 within ${timeoutMs}ms: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

function removeContainerIgnoreMissing(docker: Docker, sandboxId: string): ResultAsync<void, SandboxError> {
    return trySandbox(
        async () => {
            const container = docker.getContainer(sandboxId);
            await container.stop({ t: 5 }).catch(() => {});
            await container.remove({ force: true, v: true }).catch(() => {});
        },
        (status, cause) => ({
            type: "teardown_failed",
            op: "docker.teardown",
            sandboxId,
            status,
            cause,
        }),
    ).orElse((e) =>
        // A 404 means the container is already gone — an idempotent success.
        statusOf(e) === 404 ? ok(undefined) : err(e),
    );
}

export function createDockerSandboxOps(config: DockerClientConfig): {
    createSandbox(meta: CreateSandboxMeta, identity: SandboxIdentity): ResultAsync<SandboxRef, SandboxError>;
    teardown(ref: SandboxRef): ResultAsync<void, SandboxError>;
    teardownById(sandboxId: string): ResultAsync<void, SandboxError>;
    isAlive(ref: SandboxRef): ResultAsync<SandboxLiveness, SandboxError>;
    listManagedSandboxes(): ResultAsync<ManagedSandbox[], SandboxError>;
} {
    const docker = config.docker ?? new Docker();
    const fetchImpl = config.fetch ?? fetch;

    return {
        createSandbox(meta, identity) {
            return new ResultAsync(
                (async () => {
                    const { sandboxId, callbackSecret } = identity;

                    const plan = buildMountPlan(meta, {
                        libs: !!config.libStorePath,
                        refs: !!config.refStorePath,
                    });

                    const hostTreePath = join(config.sessionsBasePath, meta.analysisId);
                    const hostStepPath = join(hostTreePath, "runs", meta.runId, meta.stepId);
                    const binds = [
                        `${hostTreePath}:${plan.readonlyTreePath}:ro`,
                        ...(plan.writableStepPath ? [`${hostStepPath}:${plan.writableStepPath}:rw`] : []),
                        ...(config.libStorePath ? [`${config.libStorePath}:${plan.libsPath}:ro`] : []),
                        ...(config.refStorePath ? [`${config.refStorePath}:${plan.refsPath}:ro`] : []),
                    ];

                    const env = [
                        `CORTEX_BASE_URL=${config.cortexBaseUrl}`,
                        `SANDBOX_CALLBACK_SECRET=${callbackSecret}`,
                        ...Object.entries(plan.env).map(([k, v]) => `${k}=${v}`),
                        ...Object.entries(meta.extraEnv ?? {}).map(([k, v]) => `${k}=${v}`),
                    ];

                    const spec = meta.resources;
                    const createOpts: Docker.ContainerCreateOptions = {
                        name: sandboxId,
                        Image: meta.image ?? config.image,
                        Env: env,
                        WorkingDir: plan.workingDir,
                        Labels: {
                            [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
                            role: "sandbox",
                            "cortex/sandbox-id": sandboxId,
                            [OWNER_WORKFLOW_LABEL]: meta.childWorkflowId,
                            [RUN_ID_LABEL]: meta.runId,
                            [STEP_ID_LABEL]: meta.stepId,
                        },
                        HostConfig: {
                            Binds: binds,
                            NanoCpus: Math.round(spec.cpu * 1e9),
                            Memory: spec.memoryGb * 1024 ** 3,
                            PortBindings: {
                                [`${SANDBOX_SERVER_PORT}/tcp`]: [{ HostPort: "0" }],
                            },
                            AutoRemove: false,
                        },
                        ExposedPorts: {
                            [`${SANDBOX_SERVER_PORT}/tcp`]: {},
                        },
                    };

                    const createFailed = (status: number | undefined, cause: unknown): SandboxError => ({
                        type: "container_create_failed",
                        op: "docker.createSandbox",
                        sandboxId,
                        status,
                        cause,
                    });

                    // Create, or adopt an existing container under the checkpointed name
                    // (recovery re-run, see the harness-sandbox-exec spec). A running one is adopted as-is; a
                    // stopped prior attempt is removed and recreated. A 409 whose existing
                    // container is owned by a different step is a refused name collision.
                    const created = await trySandbox(() => docker.createContainer(createOpts), createFailed);

                    let container: Docker.Container;
                    let alreadyRunning = false;
                    if (created.isOk()) {
                        container = created.value;
                    } else if (statusOf(created.error) !== 409) {
                        return err(created.error);
                    } else {
                        const existing = docker.getContainer(sandboxId);
                        const inspected = await trySandbox(() => existing.inspect(), createFailed);
                        if (inspected.isErr()) return err(inspected.error);
                        const info = inspected.value;
                        // Owner-guard: only a recovery re-run carries the same checkpointed
                        // identity. A mismatch is a name collision with a different step —
                        // never adopt or remove someone else's container (see the harness-sandbox-exec spec).
                        const owner = info.Config?.Labels?.[OWNER_WORKFLOW_LABEL];
                        if (owner !== meta.childWorkflowId) {
                            return err({
                                type: "name_conflict",
                                op: "docker.createSandbox",
                                sandboxId,
                                owner: owner ?? null,
                            });
                        }
                        if (info.State.Running) {
                            container = existing;
                            alreadyRunning = true;
                        } else {
                            const removed = await removeContainerIgnoreMissing(docker, sandboxId);
                            if (removed.isErr()) return err(removed.error);
                            const recreated = await trySandbox(() => docker.createContainer(createOpts), createFailed);
                            if (recreated.isErr()) return err(recreated.error);
                            container = recreated.value;
                        }
                    }

                    if (!alreadyRunning) {
                        const started = await trySandbox(() => container.start(), createFailed);
                        if (started.isErr()) return err(started.error);
                    }

                    const inspectedRunning = await trySandbox(() => container.inspect(), createFailed);
                    if (inspectedRunning.isErr()) return err(inspectedRunning.error);
                    const info = inspectedRunning.value;

                    const bindings = info.NetworkSettings.Ports[`${SANDBOX_SERVER_PORT}/tcp`];
                    const hostPort = bindings?.[0]?.HostPort;
                    if (!hostPort) {
                        await container.stop({ t: 1 }).catch(() => {});
                        await container.remove({ force: true }).catch(() => {});
                        return err(createFailed(undefined, new Error(`DockerSandbox: no host port mapped for ${SANDBOX_SERVER_PORT}/tcp on ${sandboxId}`)));
                    }

                    const host = "127.0.0.1";
                    const port = Number(hostPort);
                    const healthy = await trySandbox(() => pollHealth(fetchImpl, `http://${host}:${port}/health`, HEALTH_TIMEOUT_MS), createFailed);
                    if (healthy.isErr()) return err(healthy.error);

                    const ref: SandboxRef = {
                        sandboxId,
                        host,
                        port,
                        backend: "docker",
                        callbackSecret,
                    };

                    const registered = await trySandbox(() => config.registerSandbox(meta, ref), createFailed);
                    if (registered.isErr()) return err(registered.error);
                    return ok(ref);
                })(),
            );
        },

        teardown(ref) {
            return removeContainerIgnoreMissing(docker, ref.sandboxId);
        },

        teardownById(sandboxId) {
            return removeContainerIgnoreMissing(docker, sandboxId);
        },

        listManagedSandboxes() {
            return trySandbox(
                () =>
                    docker.listContainers({
                        all: true,
                        filters: { label: [`${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`] },
                    }),
                (status, cause) => ({
                    type: "liveness_failed",
                    op: "docker.listManagedSandboxes",
                    status,
                    cause,
                }),
            ).map((containers) =>
                containers
                    .map((c) => {
                        const labels = c.Labels ?? {};
                        return {
                            sandboxId: labels["cortex/sandbox-id"] ?? "",
                            ownerWorkflowId: labels[OWNER_WORKFLOW_LABEL] ?? null,
                            // Docker reports `Created` as unix seconds.
                            createdAtMs: typeof c.Created === "number" ? c.Created * 1000 : null,
                        };
                    })
                    .filter((s) => s.sandboxId.length > 0),
            );
        },

        isAlive(ref) {
            return trySandbox(
                async () => {
                    const container = docker.getContainer(ref.sandboxId);
                    const info = await container.inspect();
                    return {
                        alive: info.State.Running === true,
                        oomKilled: info.State.OOMKilled === true,
                    };
                },
                (status, cause) => ({
                    type: "liveness_failed",
                    op: "docker.isAlive",
                    sandboxId: ref.sandboxId,
                    status,
                    cause,
                }),
            ).orElse((e) =>
                // dockerode throws 404 for a missing container — observably dead.
                statusOf(e) === 404 ? ok({ alive: false, oomKilled: false }) : err(e),
            );
        },
    };
}
