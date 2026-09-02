/**
 * Docker-backed `createSandbox` / `teardown` / `isAlive`.
 *
 * Thin wrapper around `dockerode`. Storage is wired via `HostConfig.Binds`:
 * a flat read-only mount of the analysis tree at `/{resourceId}`, a nested
 * read-write mount of the step's artifact dir, the package store at
 * `/mnt/libs` with the resolved farm nested inside it, and the ref store at
 * `/mnt/refs` when its host path is configured. Container paths and
 * lib-store env come from the shared mount plan (`mount-plan.ts`).
 *
 * ## The cpu files
 *
 * Two more binds put a small file over `/sys/devices/system/cpu/online` and
 * over `/proc/cpuinfo` (`cpu-files.ts`). Each file describes `spec.cpu` cpus,
 * not the host. The host side of each bind is a file under
 * `<parent of the workspace root>/.cpu/<sandboxId>/`, thus outside the tree
 * that the sandbox sees. `teardown` removes the directory when this process
 * wrote it. A directory from an earlier process stays.
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

import { lstatSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import Docker from "dockerode";
import { ResultAsync, err, ok, type Result } from "neverthrow";

import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";
import { tailWritePrefix, type ResolveWorkspaceRoot } from "../workspace/paths.js";
import { type SandboxError, trySandbox } from "./sandbox-error.js";
import { readFarmLock, resolveFarmSource } from "./farm.js";
import { buildMountPlan, sandboxWriteTail } from "./mount-plan.js";
import { CPU_ONLINE_PATH, CPUINFO_PATH, cpuFiles, readHostCpuinfoOnce } from "./cpu-files.js";
import { threadLimitEnv } from "./thread-env.js";

/** Read the originating HTTP status off any `SandboxError` variant that carries one. */
function statusOf(e: SandboxError): number | undefined {
    return "status" in e ? e.status : undefined;
}
import type {
    CreateSandboxMeta,
    FarmSource,
    ManagedSandbox,
    SandboxIdentity,
    SandboxLiveness,
    SandboxRef,
    SandboxTransport,
    ToolchainSource,
} from "./types.js";

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

/** The directory next to the workspace root that holds the cpu files of each sandbox. */
const CPU_FILES_DIR = ".cpu";

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
    /**
     * Where the farm of an analysis comes from. Required — the harness never
     * invents a farm location. `FarmLocation.farmPath` is a host directory
     * here, bind-mounted read-only at the farm container path. Consulted only
     * when `libStorePath` is set.
     */
    farmSource: FarmSource;
    /** The declared toolchain owner. Absent means `"store"`, the legacy environment. */
    toolchainSource?: ToolchainSource;
    /**
     * The deployment cannot run an analysis without the package store. Under
     * the fact, a farm that fails the `inflexa.lock` gate refuses the create
     * with `farm_unusable` and no container is made. Absent keeps the
     * degrade: the store mounts drop, a warning is logged, and the container
     * is still made. The field names the deployment fact rather than the
     * remediation, so how the harness answers it can evolve without changing
     * the embedder surface; a single-valued union (not a boolean) so future
     * store classes extend it without a breaking change.
     */
    packageStore?: "required";
    /**
     * Host ref store; bind-mounted read-only at `/mnt/refs`. Embedders pass the
     * configured store location unconditionally — existence is (re-)checked at each
     * sandbox creation, so a store installed mid-session is mounted into subsequent
     * sandboxes without a runtime restart.
     */
    refStorePath?: string;
    /**
     * Force the container platform (e.g. `linux/amd64`). Set by hosts that mount
     * a lib store so the container's arch always matches the store's native
     * binaries; a local image built for a different arch then fails loudly at
     * create rather than crashing inside the sandbox.
     */
    platform?: string;
    /**
     * Unix socket of the Docker-API engine to dial — a Docker daemon socket or a
     * podman Docker-compat socket (both serve the identical REST API). Unset
     * preserves dockerode's default resolution (`DOCKER_HOST`, then the default
     * Docker socket).
     */
    engineSocketPath?: string;
    /** Injected for tests. */
    docker?: Docker;
    /** Injected for tests so `/health` polling can be stubbed. */
    fetch?: typeof fetch;
    /**
     * Injected for tests so the `/proc/cpuinfo` of the host can be stubbed. The
     * default reads the file once per process. `undefined` means that the host
     * has no such file, for example macOS.
     */
    readHostCpuinfo?: () => Promise<string | undefined>;
    /**
     * Optional logger so a store degradation (a resolved farm whose `inflexa.lock`
     * is absent or invalid by sandbox-create time) is observable instead of a
     * silent libs-mount drop. Matches the `reaper`/`watchdog` logger seam.
     */
    logger?: Logger;
    /** Hook called after the registry row is written. */
    registerSandbox: (meta: CreateSandboxMeta, ref: SandboxRef) => Promise<void>;
}

/**
 * Whether `refStorePath` is, right now, a real directory fit to be a bind authority.
 * Deliberately shallow — it checks existence-as-a-directory only, never the store's
 * interior: the harness knows nothing of the ref store's layout, and dataset
 * completeness/receipts are the embedder's concern, so (unlike `libStoreUsable`, which
 * validates harness-known `current` layout) there is nothing here to validate beyond
 * "a directory is present."
 *
 * `lstatSync` (not `statSync`) does NOT follow symlinks, so a symlinked path is rejected
 * even when it resolves to a directory: the bind authority must itself be the store
 * directory, not an indirection that may later point elsewhere.
 *
 * Binding a missing source makes Docker auto-create a root-owned directory at the path —
 * the same hazard `libStoreUsable` documents — which would also brick the embedder's
 * later store install (its store tool cannot write into a root-owned dir).
 */
function refStoreUsable(refStorePath: string): boolean {
    try {
        return lstatSync(refStorePath).isDirectory();
    } catch {
        return false;
    }
}

/**
 * Write the cpu files of one sandbox into `dir` and return their binds.
 *
 * The directory `.cpu` is made with no `recursive` option on purpose. The
 * parent of the workspace root must exist already. Thus a root that is not on
 * disk gives no directory at an unexpected place, and the sandbox starts with
 * no cpu files. The failure is a degradation, not an error: the thread env
 * still limits each library, but `detectCores()` and `os.cpu_count()` report
 * the host.
 */
async function writeCpuFiles(
    dir: string,
    files: { readonly online: string; readonly cpuinfo: string | undefined },
    logger: Logger,
    sandboxId: string,
): Promise<string[]> {
    const ignoreExists = (cause: NodeJS.ErrnoException): void => {
        if (cause.code !== "EEXIST") throw cause;
    };
    try {
        await mkdir(dirname(dir)).catch(ignoreExists);
        await mkdir(dir).catch(ignoreExists);
        const online = join(dir, "online");
        await writeFile(online, files.online);
        const binds = [`${online}:${CPU_ONLINE_PATH}:ro`];
        if (files.cpuinfo !== undefined) {
            const cpuinfo = join(dir, "cpuinfo");
            await writeFile(cpuinfo, files.cpuinfo);
            binds.push(`${cpuinfo}:${CPUINFO_PATH}:ro`);
        }
        return binds;
    } catch (cause) {
        logger.warn("cpu files not written — the sandbox reports the cores of the host", { sandboxId, dir, cause });
        return [];
    }
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
 * dockerode connection options for a configured engine socket, or `undefined`
 * to leave construction as a bare `new Docker()` — which preserves dockerode's
 * default resolution (`DOCKER_HOST`, then the default Docker socket). A set
 * `engineSocketPath` dials that unix socket instead (a Docker daemon or a
 * podman Docker-compat socket).
 */
export function engineConnectionOptions(engineSocketPath: string | undefined): Docker.DockerOptions | undefined {
    return engineSocketPath === undefined ? undefined : { socketPath: engineSocketPath };
}

/**
 * Create the container, or adopt the one already standing under this
 * checkpointed name on a recovery re-run. Any create failure triggers an
 * inspect of the name: engines disagree on the duplicate-name status (Docker
 * answers 409, podman's compat API 500), so the reconcile keys on whether a
 * container stands under the name, not on a status code. A standing container
 * this workflow owns is adopted as-is if running, removed and recreated if
 * stopped; one owned by a different workflow is a refused name collision — never
 * adopt or remove someone else's container. When no container stands, the
 * failure was not a name collision and the original create error is returned;
 * the inspect's own failure is never surfaced, so a transient engine outage
 * (both calls fail) still reports the create failure.
 */
async function createOrAdopt(
    docker: Docker,
    createOpts: Docker.ContainerCreateOptions,
    name: string,
    ownerWorkflowId: string,
    createFailed: (status: number | undefined, cause: unknown) => SandboxError,
    logger: Logger,
): Promise<Result<{ container: Docker.Container; alreadyRunning: boolean }, SandboxError>> {
    const created = await trySandbox(() => docker.createContainer(createOpts), createFailed);
    if (created.isOk()) return ok({ container: created.value, alreadyRunning: false });

    const existing = docker.getContainer(name);
    const inspected = await trySandbox(() => existing.inspect(), createFailed);
    // No container stands under the name → the create failure was not a name
    // collision, so surface the original create error rather than the inspect's.
    if (inspected.isErr()) return err(created.error);
    const info = inspected.value;

    const owner = info.Config?.Labels?.[OWNER_WORKFLOW_LABEL];
    if (owner !== ownerWorkflowId) {
        return err({ type: "name_conflict", op: "docker.createSandbox", sandboxId: name, owner: owner ?? null });
    }
    // Both mutating reconcile outcomes are logged: adoption reuses a container the
    // current attempt did not create, so without a record here nothing ties the
    // step's sandbox back to the prior attempt that made it.
    if (info.State.Running) {
        logger.info("adopted standing container on recovery re-run", { sandboxId: name, ownerWorkflowId });
        return ok({ container: existing, alreadyRunning: true });
    }

    const removed = await removeContainerIgnoreMissing(docker, name);
    if (removed.isErr()) return err(removed.error);
    const recreated = await trySandbox(() => docker.createContainer(createOpts), createFailed);
    if (recreated.isErr()) return err(recreated.error);
    logger.info("removed stopped prior attempt and recreated", { sandboxId: name, ownerWorkflowId });
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
    isAliveById(sandboxId: string): ResultAsync<SandboxLiveness, SandboxError>;
    listManagedSandboxes(): ResultAsync<ManagedSandbox[], SandboxError>;
} {
    // The injected test instance wins; otherwise a configured socket dials that
    // engine and an unset one stays a bare `new Docker()` (default resolution).
    const connection = engineConnectionOptions(config.engineSocketPath);
    const docker = config.docker ?? (connection ? new Docker(connection) : new Docker());
    const logger = (config.logger ?? createNoopLogger()).named("docker-client");
    const fetchImpl = config.fetch ?? fetch;
    const transport: SandboxTransport = config.transport ?? "poll";
    const pollMode = transport === "poll";
    const readHostCpuinfo = config.readHostCpuinfo ?? readHostCpuinfoOnce;
    /** The cpu directory of each sandbox that this process wrote, for `teardown`. */
    const cpuDirs = new Map<string, string>();

    return {
        createSandbox(meta, identity) {
            return new ResultAsync(
                (async () => {
                    const { sandboxId, callbackSecret } = identity;

                    // Farm resolution comes before any container work: a resolver
                    // refusal and a resolver throw refuse the whole call, and no
                    // container is made. The reason of the embedder rides in the error.
                    let farm;
                    if (config.libStorePath) {
                        const resolved = await resolveFarmSource(config.farmSource, meta.analysisId, "docker.createSandbox");
                        if (resolved.isErr()) return err(resolved.error);
                        farm = resolved.value;
                    }

                    // The `inflexa.lock` gate runs at each create: the store may have
                    // gone away, or the farm may be half-written. The failure has two
                    // outcomes. Under the declared fact the call refuses with
                    // `farm_unusable` before any container work, and it logs nothing:
                    // the returned value carries the reason, and the consumer logs the
                    // throw, thus a warning here would record the one fault twice.
                    // Without the fact it degrades — both store mounts drop, the
                    // container is still made, and the sandbox reports the store as
                    // unavailable. That drop is otherwise silent, thus it is warned.
                    let libsMounted = false;
                    if (config.libStorePath && farm) {
                        const lock = readFarmLock(farm.farmPath);
                        libsMounted = lock.isOk();
                        if (lock.isErr() && config.packageStore === "required") {
                            return err({
                                type: "farm_unusable",
                                op: "docker.createSandbox",
                                analysisId: meta.analysisId,
                                farmPath: farm.farmPath,
                                lockPath: lock.error.lockPath,
                                lockError: lock.error.type,
                                cause: lock.error.cause,
                            });
                        }
                        if (lock.isErr()) {
                            logger.warn(
                                "the farm of the analysis has no usable inflexa.lock at sandbox creation — mounting no package store (sandbox degrades to available:false)",
                                { libStorePath: config.libStorePath, farmPath: farm.farmPath, lockError: lock.error.type, sandboxId },
                            );
                        }
                    }

                    // The cache path is the one farm value with no gate of its
                    // own: the lock gate proves `farmPath`, and this bind string
                    // would carry a malformed cache path verbatim. An unusable
                    // value degrades to no cache mount — the rule of a missing
                    // one — because the entrypoint fallback covers the caches.
                    const cacheBindable = farm?.cachePath !== undefined && farm.cachePath.startsWith("/") && !farm.cachePath.includes(":");
                    if (farm?.cachePath !== undefined && !cacheBindable) {
                        logger.warn("the farm cache path cannot ride a docker bind — mounting no cache", {
                            cachePath: farm.cachePath,
                            sandboxId,
                        });
                    }

                    // Re-checked here too, so a ref store installed after boot is mounted into
                    // the next sandbox. Unlike libs, a missing ref store is NOT warned: a missing
                    // lib store is a degradation (it was configured and working, then broke),
                    // whereas a missing ref store is the normal cold state — the user simply has
                    // not installed reference data yet — and warning on every create would be
                    // noise. A store that appears mid-session is picked up by the next create.
                    const refsMounted = !!config.refStorePath && refStoreUsable(config.refStorePath);

                    const plan = buildMountPlan(meta, {
                        libs: libsMounted,
                        refs: refsMounted,
                        toolchainSource: config.toolchainSource,
                        cache: cacheBindable,
                    });

                    const hostTreePath = config.resolveWorkspaceRoot(meta.analysisId);
                    // `tailWritePrefix` (not a raw `join`) so the RW bind source runs through
                    // the same validation as the pre-created write tree — a crafted stepId or
                    // a crafted tail cannot escape the resolved root into the container. The
                    // tail is the step directory, or the one the caller declared.
                    const write = sandboxWriteTail(meta);
                    // The same floor as `threadLimitEnv`: a fractional cpu request is one cpu.
                    const threads = Math.max(1, Math.floor(meta.resources.cpu));
                    const cpuinfo = await readHostCpuinfo();
                    if (cpuinfo === undefined) {
                        logger.debug("no host /proc/cpuinfo — the sandbox gets the online file only", { sandboxId });
                    }
                    // Next to the workspace root, not under it: the root is bound read-only
                    // at `/{analysisId}`, and a file under it is visible in the sandbox.
                    const cpuDir = join(dirname(hostTreePath), CPU_FILES_DIR, sandboxId);
                    const cpuBinds = await writeCpuFiles(cpuDir, cpuFiles(threads, cpuinfo), logger, sandboxId);
                    if (cpuBinds.length > 0) cpuDirs.set(sandboxId, cpuDir);
                    // The farm bind comes after the store bind, thus the nesting is
                    // stable; the cache bind comes after the two store binds.
                    const binds = [
                        `${hostTreePath}:${plan.readonlyTreePath}:ro`,
                        ...(write && plan.writableStepPath
                            ? [`${tailWritePrefix({ workspaceRoot: hostTreePath, tail: write.tail })}:${plan.writableStepPath}:rw`]
                            : []),
                        ...(libsMounted && config.libStorePath ? [`${config.libStorePath}:${plan.libsPath}:ro`] : []),
                        ...(libsMounted && farm && plan.farmPath ? [`${farm.farmPath}:${plan.farmPath}:ro`] : []),
                        ...(libsMounted && cacheBindable && farm?.cachePath && plan.cachePath ? [`${farm.cachePath}:${plan.cachePath}:rw`] : []),
                        ...(refsMounted && config.refStorePath ? [`${config.refStorePath}:${plan.refsPath}:ro`] : []),
                        ...cpuBinds,
                    ];

                    const createFailed = (status: number | undefined, cause: unknown): SandboxError => ({
                        type: "container_create_failed",
                        op: "docker.createSandbox",
                        sandboxId,
                        status,
                        cause,
                    });

                    const image = meta.image ?? config.image;

                    const spec = meta.resources;

                    // Poll mode never dials out and carries no CORTEX_BASE_URL; it sets the
                    // firewall flag so the root entrypoint installs the egress block before
                    // dropping to uid 1000. Callback mode is the inverse.
                    //
                    // Composed as one record, not as a list of `K=V`. A duplicate key in
                    // the Env array resolves at the libc that scans `environ`, thus the
                    // later spread must win here, not there.
                    const env = Object.entries({
                        SANDBOX_TRANSPORT: transport,
                        SANDBOX_CALLBACK_SECRET: callbackSecret,
                        ...(pollMode ? { SANDBOX_EGRESS_FIREWALL: "1" } : { CORTEX_BASE_URL: config.cortexBaseUrl }),
                        ...threadLimitEnv(spec),
                        ...plan.env,
                        ...(meta.extraEnv ?? {}),
                    }).map(([k, v]) => `${k}=${v}`);

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
                            // `Memory` alone lets the container swap as much again. A fork
                            // storm then thrashes for minutes, and sandbox-server stops to
                            // answer. With no swap the OOM killer removes the largest fork in
                            // seconds, and sandbox-server survives. K8s runs with no swap.
                            MemorySwap: spec.memoryGb * 1024 ** 3,
                            AutoRemove: false,
                        },
                    };

                    const sandbox = await createOrAdopt(docker, createOpts, sandboxId, meta.childWorkflowId, createFailed, logger);
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
            return teardownSandbox(ref.sandboxId);
        },

        teardownById(sandboxId) {
            return teardownSandbox(sandboxId);
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
                            // Docker label values are unconstrained, so the id is stored verbatim.
                            ownerWorkflowId: labels[OWNER_WORKFLOW_LABEL] ?? null,
                            // Docker reports `Created` as unix seconds.
                            createdAtMs: typeof c.Created === "number" ? c.Created * 1000 : null,
                        };
                    })
                    .filter((s) => s.sandboxId.length > 0),
            );
        },

        isAlive(ref) {
            return isAliveById(ref.sandboxId);
        },

        isAliveById,
    };

    /**
     * Remove the container, then the cpu files that this process wrote for it.
     * A failure of the file removal does not fail the teardown: the container is
     * gone, and a stale small directory is not a risk to a later sandbox.
     */
    function teardownSandbox(sandboxId: string): ResultAsync<void, SandboxError> {
        return removeContainerIgnoreMissing(docker, sandboxId).map(async () => {
            const cpuDir = cpuDirs.get(sandboxId);
            if (cpuDir === undefined) return;
            cpuDirs.delete(sandboxId);
            await rm(cpuDir, { recursive: true, force: true }).catch((cause: unknown) => {
                logger.debug("cpu files not removed", { sandboxId, cpuDir, cause });
            });
        });
    }

    function isAliveById(sandboxId: string): ResultAsync<SandboxLiveness, SandboxError> {
        return trySandbox(
            async () => {
                const info = await docker.getContainer(sandboxId).inspect();
                const oomKilled = info.State.OOMKilled === true;
                // A running container is a reachable sandbox: the host dials its
                // published loopback port directly.
                return { alive: info.State.Running === true, oomKilled };
            },
            (status, cause) => ({
                type: "liveness_failed",
                op: "docker.isAlive",
                sandboxId,
                status,
                cause,
            }),
        ).orElse((e) =>
            // dockerode throws 404 for a missing container — observably dead.
            statusOf(e) === 404 ? ok({ alive: false, oomKilled: false }) : err(e),
        );
    }
}
