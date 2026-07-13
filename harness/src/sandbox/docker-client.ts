/**
 * Docker-backed `createSandbox` / `teardown` / `isAlive`.
 *
 * Thin wrapper around `dockerode`. Storage is wired via `HostConfig.Binds`:
 * a flat read-only mount of the analysis tree at `/{resourceId}`, a nested
 * read-write mount of the step's artifact dir, and the lib/ref stores at
 * `/mnt/libs` / `/mnt/refs` when their host paths are configured. Container
 * paths and lib-store env come from the shared mount plan (`mount-plan.ts`).
 *
 * ## Transport and confinement
 *
 * The container joins the default bridge and publishes sandbox-server's port to
 * `127.0.0.1` only, so the host can reach `/exec` but the LAN cannot. What the
 * sandbox may do *outbound* depends on the transport:
 *
 *   - **poll** (default): the sandbox initiates nothing, so it needs no egress.
 *     The container is created as root with `CAP_NET_ADMIN` and the
 *     `SANDBOX_EGRESS_FIREWALL` flag; the image's root entrypoint installs
 *     `iptables -P OUTPUT DROP` (allowing loopback and established return
 *     traffic) and then `setpriv`-drops to the uid-1000 workload, which can
 *     neither reach the network nor flush the rules. The host polls
 *     `GET /exec/{execId}?since={cursor}` over the published port; the reply
 *     rides the established connection, so polling works with egress hard-blocked.
 *   - **callback**: the sandbox is *allowed* egress and POSTs signed callbacks to
 *     `CORTEX_BASE_URL`. It runs as uid 1000 throughout with no `NET_ADMIN` and
 *     no firewall.
 *
 * Either way the workload ends as uid 1000 with `no-new-privileges` and no
 * effective capabilities.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import Docker from "dockerode";
import type pino from "pino";
import { ResultAsync, err, ok, type Result } from "neverthrow";

import { stepWritePrefix, type ResolveWorkspaceRoot } from "../workspace/paths.js";
import { type SandboxError, trySandbox } from "./sandbox-error.js";
import { buildMountPlan } from "./mount-plan.js";

/** Read the originating HTTP status off any `SandboxError` variant that carries one. */
function statusOf(e: SandboxError): number | undefined {
    return "status" in e ? e.status : undefined;
}
import type { CreateSandboxMeta, ManagedSandbox, SandboxIdentity, SandboxLiveness, SandboxRef, SandboxTransport } from "./types.js";

const SANDBOX_SERVER_PORT = 8765;
const HEALTH_TIMEOUT_MS = 30_000;

/** Only this process dials the published port; binding it on every host interface would expose `/exec` to the LAN. */
const SANDBOX_PORT_HOST_IP = "127.0.0.1";

/** Matches `USER sandbox` (uid/gid 1000) in the sandbox images — the callback-mode workload user. */
const SANDBOX_USER = "1000:1000";
/**
 * Poll mode starts the container as root so the entrypoint can install the
 * egress firewall; the entrypoint then `setpriv`-drops to uid 1000, so the
 * workload still runs unprivileged. sandbox-server refuses to start as root
 * when the firewall flag is set, so an image whose entrypoint skips the drop
 * fails at create time rather than running privileged and unconfined.
 */
const SANDBOX_ROOT_USER = "0:0";
const HEALTH_POLL_MS = 250;

const MANAGED_BY_LABEL = "app.kubernetes.io/managed-by";
const MANAGED_BY_VALUE = "cortex";
const OWNER_WORKFLOW_LABEL = "cortex/owner-workflow-id";
const RUN_ID_LABEL = "cortex/run-id";
const STEP_ID_LABEL = "cortex/step-id";

export interface DockerClientConfig {
    image: string;
    /** Cortex base URL injected into the sandbox env in callback mode so callbacks land here. Unused in poll mode. */
    cortexBaseUrl: string;
    /** Result transport. `poll` (default) confines the sandbox with the egress firewall; `callback` permits egress. */
    transport?: SandboxTransport;
    /** Workspace-root resolution seam; each analysis's resolved root is the bind source for its tree mounts. */
    resolveWorkspaceRoot: ResolveWorkspaceRoot;
    /** Host lib store; bind-mounted read-only at `/mnt/libs` when set. */
    libStorePath?: string;
    /** Host ref store; bind-mounted read-only at `/mnt/refs` when set. */
    refStorePath?: string;
    /**
     * Force the container platform (e.g. `linux/amd64`). Set by hosts that mount
     * a lib store so the container's arch always matches the store's native
     * binaries; a local image built for a different arch then fails loudly at
     * create rather than crashing inside the sandbox.
     */
    platform?: string;
    /** Injected for tests. */
    docker?: Docker;
    /** Injected for tests so `/health` polling can be stubbed. */
    fetch?: typeof fetch;
    /**
     * Optional logger so a lib-store degradation (a configured store whose `current`
     * vanished or went incomplete by sandbox-create time) is observable instead of a
     * silent libs-mount drop. Matches the `reaper`/`watchdog` logger seam.
     */
    logger?: Pick<pino.Logger, "info" | "warn" | "error">;
    /** Hook called after the registry row is written. */
    registerSandbox: (meta: CreateSandboxMeta, ref: SandboxRef) => Promise<void>;
}

/**
 * Whether the lib store's `current` resolves to a COMPLETE, usable version, not merely a
 * present symlink. By sandbox-create time `current` may be gone (concurrent prune/`rm`), a
 * dangling symlink (its target pruned), or an incomplete tree. Binding a missing source
 * makes Docker auto-create a root-owned dir (bricking a later store refresh); binding a broken
 * one mounts broken content. Require a resolved directory carrying both completeness
 * markers `activate` writes before it flips the pointer.
 */
function libStoreUsable(libStorePath: string): boolean {
    const current = join(libStorePath, "current");
    try {
        // statSync FOLLOWS the symlink, so a dangling `current` throws here and is rejected.
        if (!statSync(current).isDirectory()) return false;
    } catch {
        return false;
    }
    return existsSync(join(current, "packages.txt")) && existsSync(join(current, "meta.json"));
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

/**
 * Create the container, or adopt the one already standing under this
 * checkpointed name (a recovery re-run, see the harness-sandbox-exec spec). A
 * running container is adopted as-is; a stopped prior attempt is removed and
 * recreated. A 409 whose container belongs to a different workflow is a refused
 * name collision — never adopt or remove someone else's container.
 */
async function createOrAdopt(
    docker: Docker,
    createOpts: Docker.ContainerCreateOptions,
    name: string,
    ownerWorkflowId: string,
    createFailed: (status: number | undefined, cause: unknown) => SandboxError,
): Promise<Result<{ container: Docker.Container; alreadyRunning: boolean }, SandboxError>> {
    const created = await trySandbox(() => docker.createContainer(createOpts), createFailed);
    if (created.isOk()) return ok({ container: created.value, alreadyRunning: false });
    if (statusOf(created.error) !== 409) return err(created.error);

    const existing = docker.getContainer(name);
    const inspected = await trySandbox(() => existing.inspect(), createFailed);
    if (inspected.isErr()) return err(inspected.error);
    const info = inspected.value;

    const owner = info.Config?.Labels?.[OWNER_WORKFLOW_LABEL];
    if (owner !== ownerWorkflowId) {
        return err({ type: "name_conflict", op: "docker.createSandbox", sandboxId: name, owner: owner ?? null });
    }
    if (info.State.Running) return ok({ container: existing, alreadyRunning: true });

    const removed = await removeContainerIgnoreMissing(docker, name);
    if (removed.isErr()) return err(removed.error);
    const recreated = await trySandbox(() => docker.createContainer(createOpts), createFailed);
    if (recreated.isErr()) return err(recreated.error);
    return ok({ container: recreated.value, alreadyRunning: false });
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
    const transport: SandboxTransport = config.transport ?? "poll";
    const pollMode = transport === "poll";

    return {
        createSandbox(meta, identity) {
            return new ResultAsync(
                (async () => {
                    const { sandboxId, callbackSecret } = identity;

                    // Re-check AT sandbox-creation time: `config.libStorePath` was fixed at CLI
                    // boot and the store may have gone away since (see libStoreUsable). Not
                    // usable → skip the mount (sandbox degrades to available:false) and log it,
                    // since an otherwise-silent libs-mount drop is invisible to operators.
                    const libsMounted = !!config.libStorePath && libStoreUsable(config.libStorePath);
                    if (config.libStorePath && !libsMounted) {
                        config.logger?.warn(
                            { libStorePath: config.libStorePath, sandboxId },
                            "[docker-client] lib store configured but `current` is missing or incomplete at sandbox creation — mounting no library store (sandbox degrades to available:false)",
                        );
                    }

                    const plan = buildMountPlan(meta, {
                        libs: libsMounted,
                        refs: !!config.refStorePath,
                    });

                    const hostTreePath = config.resolveWorkspaceRoot(meta.analysisId);
                    // `stepWritePrefix` (not a raw `join`) so the RW bind source runs through
                    // the same id validation as the pre-created step tree — a crafted stepId
                    // cannot escape the resolved root into the container.
                    const hostStepPath = stepWritePrefix({ workspaceRoot: hostTreePath, runId: meta.runId, stepId: meta.stepId });
                    const binds = [
                        `${hostTreePath}:${plan.readonlyTreePath}:ro`,
                        ...(plan.writableStepPath ? [`${hostStepPath}:${plan.writableStepPath}:rw`] : []),
                        ...(libsMounted && config.libStorePath ? [`${config.libStorePath}:${plan.libsPath}:ro`] : []),
                        ...(config.refStorePath ? [`${config.refStorePath}:${plan.refsPath}:ro`] : []),
                    ];

                    const createFailed = (status: number | undefined, cause: unknown): SandboxError => ({
                        type: "container_create_failed",
                        op: "docker.createSandbox",
                        sandboxId,
                        status,
                        cause,
                    });

                    const image = meta.image ?? config.image;

                    // Poll mode never dials out and carries no CORTEX_BASE_URL; it sets the
                    // firewall flag so the root entrypoint installs the egress block before
                    // dropping to uid 1000. Callback mode is the inverse.
                    const env = [
                        `SANDBOX_TRANSPORT=${transport}`,
                        `SANDBOX_CALLBACK_SECRET=${callbackSecret}`,
                        ...(pollMode ? ["SANDBOX_EGRESS_FIREWALL=1"] : [`CORTEX_BASE_URL=${config.cortexBaseUrl}`]),
                        ...Object.entries(plan.env).map(([k, v]) => `${k}=${v}`),
                        ...Object.entries(meta.extraEnv ?? {}).map(([k, v]) => `${k}=${v}`),
                    ];

                    const spec = meta.resources;
                    const createOpts: Docker.ContainerCreateOptions = {
                        name: sandboxId,
                        ...(config.platform !== undefined && { platform: config.platform }),
                        Image: image,
                        Env: env,
                        User: pollMode ? SANDBOX_ROOT_USER : SANDBOX_USER,
                        WorkingDir: plan.workingDir,
                        Labels: {
                            [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
                            [OWNER_WORKFLOW_LABEL]: meta.childWorkflowId,
                            [RUN_ID_LABEL]: meta.runId,
                            [STEP_ID_LABEL]: meta.stepId,
                            role: "sandbox",
                            "cortex/sandbox-id": sandboxId,
                        },
                        ExposedPorts: { [`${SANDBOX_SERVER_PORT}/tcp`]: {} },
                        HostConfig: {
                            Binds: binds,
                            // Published to loopback only: the host reaches `/exec`, the LAN cannot.
                            PortBindings: {
                                [`${SANDBOX_SERVER_PORT}/tcp`]: [{ HostIp: SANDBOX_PORT_HOST_IP, HostPort: "0" }],
                            },
                            CapDrop: ["ALL"],
                            // Poll mode grants the ROOT entrypoint exactly what its privileged
                            // setup needs: NET_ADMIN to install the egress iptables rules,
                            // SETUID/SETGID for the setpriv uid/gid drop to the workload user
                            // (setresuid/setresgid fail EPERM without them), and SETPCAP to apply
                            // setpriv's `--bounding-set=-all`. The entrypoint drops all of them
                            // before the workload runs — the workload's capability sets end empty
                            // — and `no-new-privileges` prevents regaining any.
                            ...(pollMode ? { CapAdd: ["NET_ADMIN", "SETUID", "SETGID", "SETPCAP"] } : {}),
                            SecurityOpt: ["no-new-privileges"],
                            NanoCpus: Math.round(spec.cpu * 1e9),
                            Memory: spec.memoryGb * 1024 ** 3,
                            AutoRemove: false,
                        },
                    };

                    const sandbox = await createOrAdopt(docker, createOpts, sandboxId, meta.childWorkflowId, createFailed);
                    if (sandbox.isErr()) return err(sandbox.error);
                    if (!sandbox.value.alreadyRunning) {
                        const started = await trySandbox(() => sandbox.value.container.start(), createFailed);
                        if (started.isErr()) return err(started.error);
                    }

                    const inspected = await trySandbox(() => sandbox.value.container.inspect(), createFailed);
                    if (inspected.isErr()) return err(inspected.error);
                    const hostPort = inspected.value.NetworkSettings.Ports?.[`${SANDBOX_SERVER_PORT}/tcp`]?.[0]?.HostPort;
                    if (!hostPort) {
                        // A container we cannot reach is useless; stop and remove it so a retry
                        // starts clean rather than colliding with an unroutable name.
                        (await removeContainerIgnoreMissing(docker, sandboxId)).unwrapOr(undefined);
                        return err(createFailed(undefined, new Error(`DockerSandbox: no host port mapped for ${SANDBOX_SERVER_PORT}/tcp on ${sandboxId}`)));
                    }

                    const host = SANDBOX_PORT_HOST_IP;
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
                    const info = await docker.getContainer(ref.sandboxId).inspect();
                    const oomKilled = info.State.OOMKilled === true;
                    // A running container is a reachable sandbox: the host dials its
                    // published loopback port directly.
                    return { alive: info.State.Running === true, oomKilled };
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
