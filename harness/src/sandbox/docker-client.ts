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
 *
 * ## Network topology
 *
 * The sandbox is attached to a per-analysis `--internal` network and nothing
 * else, which removes every route off that bridge — no internet, no LAN, no
 * host. `--internal` is not an egress filter: it also removes published ports,
 * so it disconnects the host from the sandbox just as thoroughly. What restores
 * the two directions the exec protocol needs is a **gateway** sidecar, one per
 * sandbox, running `sandbox-server gateway` out of the same image:
 *
 *   host    --(127.0.0.1:ephemeral)-->  gateway :8765 --> sandbox:8765   (/exec)
 *   sandbox --(CORTEX_BASE_URL)------>  gateway :8766 --> Cortex ingress (callbacks)
 *
 * The sandbox therefore keeps exactly one reachable peer, and that peer forwards
 * to exactly one place. The gateway is never handed `SANDBOX_CALLBACK_SECRET`:
 * it moves bytes and cannot mint a signature, so it can delay or drop a
 * completion but never forge one.
 *
 * `CORTEX_BASE_URL` keeps its original scheme and hostname — only the port
 * changes. The sandbox's `/etc/hosts` (`HostConfig.ExtraHosts`) pins that
 * hostname to the gateway's address on the internal network, which preserves
 * TLS SNI and the `Host` header for an upstream that cares. A DNS alias on the
 * gateway would have been the obvious alternative and is a trap: the gateway is
 * multi-homed, so it resolves its own alias and forwards to itself.
 *
 * ## Why the network is per-analysis and not per-sandbox
 *
 * Two sandboxes on the same internal network can reach each other, and
 * `/exec` is unauthenticated. Per-analysis is nonetheless the right boundary,
 * because it is the boundary that already exists: every step of an analysis
 * receives a flat read-only mount of the entire analysis tree, so steps within
 * one analysis are not isolated from each other today by any measure. Different
 * analyses are mutually unreachable, which is the property that was missing.
 * (Per-sandbox networks would be tighter, but each internal network consumes a
 * subnet from Docker's default address pool — roughly thirty are available —
 * which would silently cap concurrent steps.)
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import Docker from "dockerode";
import type pino from "pino";
import { ResultAsync, err, ok, type Result } from "neverthrow";

import { type SandboxError, trySandbox } from "./sandbox-error.js";
import { buildMountPlan } from "./mount-plan.js";

/** Read the originating HTTP status off any `SandboxError` variant that carries one. */
function statusOf(e: SandboxError): number | undefined {
    return "status" in e ? e.status : undefined;
}
import type { CreateSandboxMeta, ManagedSandbox, SandboxIdentity, SandboxLiveness, SandboxRef } from "./types.js";

const SANDBOX_SERVER_PORT = 8765;
const HEALTH_TIMEOUT_MS = 30_000;

/** The gateway's inbound leg: published to loopback, forwards to the sandbox's `/exec`. */
const GATEWAY_INBOUND_PORT = 8765;

/** The gateway's outbound leg: the sandbox's only route to the Cortex ingress. */
const GATEWAY_OUTBOUND_PORT = 8766;

/** Only this process dials the published port; binding it on every host interface would expose `/exec` to the LAN. */
const SANDBOX_PORT_HOST_IP = "127.0.0.1";

/** Matches `USER sandbox` (uid/gid 1000) in the sandbox images. Asserted at run time so a swapped `meta.image` cannot silently execute as root. */
const SANDBOX_USER = "1000:1000";
const HEALTH_POLL_MS = 250;

/**
 * The gateway shuttles bytes between two sockets. A cap this size is generous
 * for a statically-linked Go binary with no allocations per connection beyond
 * `io.Copy` buffers, and it bounds the blast radius of a runaway forwarder.
 */
const GATEWAY_MEMORY_BYTES = 128 * 1024 ** 2;

const MANAGED_BY_LABEL = "app.kubernetes.io/managed-by";
const MANAGED_BY_VALUE = "cortex";
const OWNER_WORKFLOW_LABEL = "cortex/owner-workflow-id";
const RUN_ID_LABEL = "cortex/run-id";
const STEP_ID_LABEL = "cortex/step-id";
const GATEWAY_FOR_LABEL = "cortex/gateway-for";
/** Carried by both the sandbox and its gateway so teardown can find the network to sweep. */
const ANALYSIS_ID_LABEL = "cortex/analysis-id";

/**
 * The internal network shared by every sandbox of one analysis. Naming it after
 * the analysis is what makes creation idempotent across the steps that share it.
 */
function analysisNetworkName(analysisId: string): string {
    return `cortex-sbx-${analysisId}`;
}

function gatewayContainerName(sandboxId: string): string {
    return `${sandboxId}-gw`;
}

/** Where the gateway's outbound leg forwards to: the real Cortex ingress. */
function upstreamIngress(cortexBaseUrl: string): { host: string; port: string; protocol: string } {
    const url = new URL(cortexBaseUrl);
    return {
        host: url.hostname,
        port: url.port !== "" ? url.port : url.protocol === "https:" ? "443" : "80",
        protocol: url.protocol,
    };
}

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

/** Docker reports an already-created object as a 409, and an already-joined network endpoint as a 403. */
function statusCodeOf(cause: unknown): number | undefined {
    return typeof cause === "object" && cause !== null && "statusCode" in cause && typeof cause.statusCode === "number" ? cause.statusCode : undefined;
}

/**
 * Create the analysis's internal network, tolerating the common case where a
 * sibling step created it first. `Internal: true` is the whole control: it
 * withholds the default route and the masquerade rule, so a container on this
 * network can reach only its own subnet.
 */
async function ensureAnalysisNetwork(docker: Docker, name: string): Promise<void> {
    try {
        await docker.createNetwork({
            Name: name,
            Driver: "bridge",
            Internal: true,
            Labels: { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE },
        });
    } catch (cause) {
        if (statusCodeOf(cause) !== 409) throw cause;
    }
}

/**
 * Attach a container to the analysis network.
 *
 * Tolerates an endpoint that already exists (403/409 — a recovery re-run), and
 * recreates the network once on a 404. That 404 is not hypothetical: a sibling
 * step's teardown can remove the network in the window between our
 * `ensureAnalysisNetwork` and this call, when it holds no endpoints yet.
 */
async function connectToNetwork(docker: Docker, networkName: string, containerName: string): Promise<void> {
    try {
        await docker.getNetwork(networkName).connect({ Container: containerName });
        return;
    } catch (cause) {
        const status = statusCodeOf(cause);
        if (status === 403 || status === 409) return;
        if (status !== 404) throw cause;
    }
    await ensureAnalysisNetwork(docker, networkName);
    await docker.getNetwork(networkName).connect({ Container: containerName });
}

/**
 * Drop the analysis network once its last sandbox is gone. Docker refuses with
 * a 403 while endpoints remain, which is precisely the signal that a sibling
 * step is still running — so a failure here is the expected outcome, not an
 * error. Left unswept, these networks would exhaust Docker's default address
 * pool after about thirty analyses.
 */
async function removeNetworkIfUnused(docker: Docker, name: string): Promise<void> {
    await docker
        .getNetwork(name)
        .remove()
        .catch(() => {});
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

/**
 * Remove a sandbox and the gateway that fronts it, then drop the analysis
 * network if this was its last member. Every step is idempotent: teardown runs
 * on the happy path, on failure, and again from the reaper.
 */
function removeSandboxAndGateway(docker: Docker, sandboxId: string): ResultAsync<void, SandboxError> {
    return ResultAsync.fromSafePromise(
        (async () => {
            // Read the analysis before the containers go, or we lose the network's
            // name with them. Either container carries the label; the sandbox may
            // already be gone when the reaper gets here.
            let analysisId: string | undefined;
            for (const name of [sandboxId, gatewayContainerName(sandboxId)]) {
                try {
                    const info = await docker.getContainer(name).inspect();
                    analysisId = info.Config?.Labels?.[ANALYSIS_ID_LABEL];
                    if (analysisId) break;
                } catch {
                    // Already gone — try the other one.
                }
            }
            return analysisId;
        })(),
    )
        .andThen((analysisId) =>
            // Remove the gateway FIRST, the sandbox LAST. The reaper rediscovers orphans
            // by the sandbox's `cortex/sandbox-id` label — a label the gateway lacks — so
            // the sandbox must be the last thing to go. If either removal errors (a real
            // daemon fault, not a 404, which is swallowed as success), the chain stops
            // with the sandbox still present and the next sweep retries the whole teardown.
            // The reverse order would let a gateway outlive its sandbox and leak
            // unreapably.
            removeContainerIgnoreMissing(docker, gatewayContainerName(sandboxId))
                .andThen(() => removeContainerIgnoreMissing(docker, sandboxId))
                .map(() => analysisId),
        )
        .andThen((analysisId) =>
            ResultAsync.fromSafePromise(analysisId === undefined ? Promise.resolve() : removeNetworkIfUnused(docker, analysisNetworkName(analysisId))),
        );
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

                    const hostTreePath = join(config.sessionsBasePath, meta.analysisId);
                    const hostStepPath = join(hostTreePath, "runs", meta.runId, meta.stepId);
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
                    const networkName = analysisNetworkName(meta.analysisId);
                    const gatewayName = gatewayContainerName(sandboxId);
                    const upstream = upstreamIngress(config.cortexBaseUrl);

                    const sharedLabels = {
                        [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
                        [OWNER_WORKFLOW_LABEL]: meta.childWorkflowId,
                        [ANALYSIS_ID_LABEL]: meta.analysisId,
                        [RUN_ID_LABEL]: meta.runId,
                        [STEP_ID_LABEL]: meta.stepId,
                    };

                    const network = await trySandbox(() => ensureAnalysisNetwork(docker, networkName), createFailed);
                    if (network.isErr()) return err(network.error);

                    // The gateway is created on the default bridge, which is the only way it
                    // can both publish a port to the host and reach the Cortex ingress; it
                    // joins the internal network afterwards. It carries no callback secret and
                    // no mounts — it forwards bytes and nothing else.
                    const gatewayOpts: Docker.ContainerCreateOptions = {
                        name: gatewayName,
                        ...(config.platform !== undefined && { platform: config.platform }),
                        Image: image,
                        Cmd: ["sandbox-server", "gateway"],
                        Env: [
                            `GATEWAY_INBOUND_PORT=${GATEWAY_INBOUND_PORT}`,
                            `GATEWAY_INBOUND_TARGET=${sandboxId}:${SANDBOX_SERVER_PORT}`,
                            `GATEWAY_OUTBOUND_PORT=${GATEWAY_OUTBOUND_PORT}`,
                            `GATEWAY_OUTBOUND_TARGET=${upstream.host}:${upstream.port}`,
                        ],
                        User: SANDBOX_USER,
                        Labels: { ...sharedLabels, role: "sandbox-gateway", [GATEWAY_FOR_LABEL]: sandboxId },
                        HostConfig: {
                            CapDrop: ["ALL"],
                            SecurityOpt: ["no-new-privileges"],
                            Memory: GATEWAY_MEMORY_BYTES,
                            PortBindings: {
                                [`${GATEWAY_INBOUND_PORT}/tcp`]: [{ HostIp: SANDBOX_PORT_HOST_IP, HostPort: "0" }],
                            },
                            AutoRemove: false,
                        },
                        ExposedPorts: { [`${GATEWAY_INBOUND_PORT}/tcp`]: {} },
                    };

                    // An adopted gateway keeps the outbound target it was created with, which
                    // after a host restart points at a dead ingress port. That is survivable
                    // and deliberately not repaired here: recreating it would move its
                    // published port, invalidating the `SandboxRef` already checkpointed in
                    // the `createSandbox` step cache. Push may be dead; `awaitExec` pulls.
                    const gateway = await createOrAdopt(docker, gatewayOpts, gatewayName, meta.childWorkflowId, createFailed);
                    if (gateway.isErr()) return err(gateway.error);

                    /**
                     * Abandon a create that has already brought the gateway up.
                     *
                     * The reaper collects orphans by enumerating containers that carry a
                     * `cortex/sandbox-id` label, and the gateway deliberately carries none —
                     * so nothing will ever collect it, nor the network its endpoint pins.
                     * Every failure between here and the sandbox container's creation must
                     * therefore take the gateway with it. Once the sandbox container exists it
                     * is labelled, the reaper can see it, and `teardownById` removes both.
                     */
                    const abandon = async (e: SandboxError): Promise<Result<SandboxRef, SandboxError>> => {
                        // Best-effort. The create has already failed and `e` is the error worth
                        // reporting; a cleanup that also fails leaves an orphan for an operator,
                        // which beats masking the cause with a teardown error.
                        (await removeContainerIgnoreMissing(docker, gatewayName)).unwrapOr(undefined);
                        await removeNetworkIfUnused(docker, networkName);
                        return err(e);
                    };

                    if (!gateway.value.alreadyRunning) {
                        const started = await trySandbox(() => gateway.value.container.start(), createFailed);
                        if (started.isErr()) return abandon(started.error);
                    }

                    // Attaching the gateway before the sandbox is created is load-bearing, not
                    // incidental: from here on the network has an endpoint, so a sibling step's
                    // teardown gets a 403 from `removeNetworkIfUnused` and leaves it standing.
                    // The only window where the network can be swept out from under us is the
                    // one this call closes, which is why it — and not the sandbox create —
                    // carries the recreate-on-404 retry.
                    const joined = await trySandbox(() => connectToNetwork(docker, networkName, gatewayName), createFailed);
                    if (joined.isErr()) return abandon(joined.error);

                    const gatewayInspected = await trySandbox(() => gateway.value.container.inspect(), createFailed);
                    if (gatewayInspected.isErr()) return abandon(gatewayInspected.error);
                    const gatewayInfo = gatewayInspected.value;

                    const gatewayIp = gatewayInfo.NetworkSettings.Networks?.[networkName]?.IPAddress;
                    if (!gatewayIp) {
                        return abandon(createFailed(undefined, new Error(`DockerSandbox: gateway ${gatewayName} has no address on ${networkName}`)));
                    }
                    const hostPort = gatewayInfo.NetworkSettings.Ports[`${GATEWAY_INBOUND_PORT}/tcp`]?.[0]?.HostPort;
                    if (!hostPort) {
                        return abandon(
                            createFailed(undefined, new Error(`DockerSandbox: no host port mapped for ${GATEWAY_INBOUND_PORT}/tcp on ${gatewayName}`)),
                        );
                    }

                    const env = [
                        // Scheme and hostname are preserved so an upstream that terminates TLS
                        // still sees the SNI and Host it expects; only the port moves. The
                        // hostname resolves to the gateway via ExtraHosts below.
                        `CORTEX_BASE_URL=${upstream.protocol}//${upstream.host}:${GATEWAY_OUTBOUND_PORT}`,
                        `SANDBOX_CALLBACK_SECRET=${callbackSecret}`,
                        ...Object.entries(plan.env).map(([k, v]) => `${k}=${v}`),
                        ...Object.entries(meta.extraEnv ?? {}).map(([k, v]) => `${k}=${v}`),
                    ];

                    const spec = meta.resources;
                    const createOpts: Docker.ContainerCreateOptions = {
                        name: sandboxId,
                        ...(config.platform !== undefined && { platform: config.platform }),
                        Image: image,
                        Env: env,
                        User: SANDBOX_USER,
                        WorkingDir: plan.workingDir,
                        Labels: { ...sharedLabels, role: "sandbox", "cortex/sandbox-id": sandboxId },
                        HostConfig: {
                            Binds: binds,
                            // The whole confinement: an internal network has no default route, so
                            // this container can reach nothing but its own subnet — where the only
                            // thing it can usefully talk to is its gateway. It publishes no port
                            // (an internal network silently ignores port bindings), so `/exec` is
                            // reachable only through the gateway's loopback-bound one.
                            NetworkMode: networkName,
                            ExtraHosts: [`${upstream.host}:${gatewayIp}`],
                            CapDrop: ["ALL"],
                            SecurityOpt: ["no-new-privileges"],
                            NanoCpus: Math.round(spec.cpu * 1e9),
                            Memory: spec.memoryGb * 1024 ** 3,
                            AutoRemove: false,
                        },
                    };

                    // The last point at which the gateway is still an orphan-in-waiting. Past
                    // this line the sandbox container exists and carries `cortex/sandbox-id`,
                    // so the reaper can find it and `teardownById` will collect both.
                    const sandbox = await createOrAdopt(docker, createOpts, sandboxId, meta.childWorkflowId, createFailed);
                    if (sandbox.isErr()) return abandon(sandbox.error);
                    if (!sandbox.value.alreadyRunning) {
                        const started = await trySandbox(() => sandbox.value.container.start(), createFailed);
                        if (started.isErr()) return err(started.error);
                    }

                    // Probing the sandbox's own `/health` *through* the gateway proves the whole
                    // ingress chain, not merely that a forwarder is listening.
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
            return removeSandboxAndGateway(docker, ref.sandboxId);
        },

        teardownById(sandboxId) {
            return removeSandboxAndGateway(docker, sandboxId);
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
                    if (info.State.Running !== true) return { alive: false, oomKilled };

                    // A sandbox created before this topology shipped has no gateway and
                    // reaches the host through its own published port, so its liveness is
                    // just the container's. Requiring a gateway of it would report a running,
                    // reachable sandbox dead across a binary upgrade with an in-flight run.
                    // Only gateway-fronted sandboxes carry the analysis-id label.
                    const gatewayFronted = info.Config?.Labels?.[ANALYSIS_ID_LABEL] !== undefined;
                    if (!gatewayFronted) return { alive: true, oomKilled };

                    // For a gateway-fronted sandbox, a dead gateway means unreachable in both
                    // directions — no exec can be submitted, no completion can leave. It is
                    // alive only in the sense that a process still runs, and reporting it alive
                    // would leave the watchdog waiting on a recv that can never unblock, which
                    // is the very wedge this topology exists inside of.
                    const gateway = await docker
                        .getContainer(gatewayContainerName(ref.sandboxId))
                        .inspect()
                        .catch((cause: unknown) => {
                            if (statusCodeOf(cause) === 404) return null;
                            throw cause;
                        });
                    return { alive: gateway?.State.Running === true, oomKilled };
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
