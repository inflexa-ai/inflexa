/**
 * Per-backend createSandbox/teardown/isAlive tests against a mocked
 * Docker client. Covers the contract the SandboxClient factory wraps.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Docker from "dockerode";

import { createDockerSandboxOps } from "./docker-client.js";
import { mintSandboxIdentity } from "./identity.js";

// A real, COMPLETE on-disk lib store: the Docker client re-checks `<libStorePath>/current`
// AT createSandbox time and requires it to resolve to a directory carrying both
// completeness markers (packages.txt + meta.json), not merely to exist (findings 4/5), so
// tests that expect the /mnt/libs mount must point at a store that is actually usable.
let libRoot: string;
async function writeCompleteStore(root: string, version: string): Promise<void> {
    const vdir = join(root, version);
    await mkdir(vdir, { recursive: true });
    await writeFile(join(vdir, "packages.txt"), "# packages\n");
    await writeFile(join(vdir, "meta.json"), JSON.stringify({ version, arch: "linux-amd64", tracks: [] }));
    await symlink(version, join(root, "current"));
}
beforeEach(async () => {
    libRoot = await mkdtemp(join(tmpdir(), "harness-libstore-"));
    await writeCompleteStore(libRoot, "2026.07.04-abc");
});
afterEach(async () => {
    await rm(libRoot, { recursive: true, force: true });
});

/** The internal network the sandbox is confined to, for `analysisId: "an-1"`. */
const NETWORK = "cortex-sbx-an-1";

interface CreatedContainer {
    name: string;
    image?: string;
    cmd?: string[];
    env: string[];
    binds: string[];
    labels?: Record<string, string>;
    workingDir?: string;
    platform?: string;
    /** Whether the `platform` key was present at all on createOpts — the config-unset case must OMIT it, not pass undefined. */
    hasPlatformKey: boolean;
    user?: string;
    capDrop?: string[];
    securityOpt?: string[];
    networkMode?: string;
    extraHosts?: string[];
    portBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }>>;
}

interface CreateOpts {
    name: string;
    Image?: string;
    Cmd?: string[];
    Env: string[];
    User?: string;
    WorkingDir?: string;
    platform?: string;
    Labels?: Record<string, string>;
    HostConfig?: {
        Binds?: string[];
        CapDrop?: string[];
        SecurityOpt?: string[];
        NetworkMode?: string;
        ExtraHosts?: string[];
        PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }>>;
    };
}

function notFound(): Error & { statusCode: number } {
    const err = new Error("no such container") as Error & { statusCode: number };
    err.statusCode = 404;
    return err;
}

/** Find the sandbox (not the gateway) among the created containers. */
function sandboxOf(created: CreatedContainer[]): CreatedContainer | undefined {
    return created.find((c) => c.labels?.role === "sandbox");
}

/** Find the gateway among the created containers. */
function gatewayOf(created: CreatedContainer[]): CreatedContainer | undefined {
    return created.find((c) => c.labels?.role === "sandbox-gateway");
}

function stubDocker(): {
    docker: Docker;
    created: CreatedContainer[];
    removed: string[];
    running: Map<string, boolean>;
    oomKilled: Set<string>;
    networks: Map<string, { internal: boolean; members: Set<string> }>;
    removedNetworks: string[];
    /** Container name → labels its inspect reports. Seed directly to model a container not created through the ops. */
    labelsByName: Map<string, Record<string, string>>;
} {
    const created: CreatedContainer[] = [];
    const removed: string[] = [];
    const running = new Map<string, boolean>();
    const oomKilled = new Set<string>();
    const networks = new Map<string, { internal: boolean; members: Set<string> }>();
    const removedNetworks: string[] = [];
    const labelsByName = new Map<string, Record<string, string>>();

    const makeContainer = (id: string) => ({
        id,
        start: async () => {
            running.set(id, true);
        },
        inspect: async () => {
            if (!running.has(id)) throw notFound();
            // Only the gateway publishes a port; the sandbox sits on an internal
            // network where Docker silently ignores port bindings.
            const isGateway = labelsByName.get(id)?.role === "sandbox-gateway";
            const attached = [...networks.entries()].filter(([, n]) => n.members.has(id));
            return {
                Config: { Labels: labelsByName.get(id) ?? {} },
                NetworkSettings: {
                    Ports: isGateway ? { "8765/tcp": [{ HostPort: "32100" }] } : {},
                    Networks: Object.fromEntries(attached.map(([name]) => [name, { IPAddress: "172.24.0.2" }])),
                },
                State: { Running: running.get(id) === true, OOMKilled: oomKilled.has(id) },
            };
        },
        stop: async () => {
            running.set(id, false);
        },
        remove: async () => {
            removed.push(id);
            running.delete(id);
        },
    });

    const docker = {
        createContainer: async (opts: CreateOpts) => {
            created.push({
                name: opts.name,
                image: opts.Image,
                cmd: opts.Cmd,
                env: opts.Env,
                binds: opts.HostConfig?.Binds ?? [],
                labels: opts.Labels,
                workingDir: opts.WorkingDir,
                platform: opts.platform,
                hasPlatformKey: Object.prototype.hasOwnProperty.call(opts, "platform"),
                user: opts.User,
                capDrop: opts.HostConfig?.CapDrop,
                securityOpt: opts.HostConfig?.SecurityOpt,
                networkMode: opts.HostConfig?.NetworkMode,
                extraHosts: opts.HostConfig?.ExtraHosts,
                portBindings: opts.HostConfig?.PortBindings,
            });
            labelsByName.set(opts.name, opts.Labels ?? {});
            // A sandbox names its network via NetworkMode; Docker attaches it at create.
            const mode = opts.HostConfig?.NetworkMode;
            if (mode) networks.get(mode)?.members.add(opts.name);
            return makeContainer(opts.name);
        },
        getContainer: (id: string) => makeContainer(id),
        createNetwork: async (opts: { Name: string; Internal?: boolean }) => {
            if (networks.has(opts.Name)) {
                const err = new Error(`network ${opts.Name} already exists`) as Error & { statusCode: number };
                err.statusCode = 409;
                throw err;
            }
            networks.set(opts.Name, { internal: opts.Internal === true, members: new Set() });
            return {};
        },
        getNetwork: (name: string) => ({
            connect: async ({ Container }: { Container: string }) => {
                const net = networks.get(name);
                if (!net) {
                    const err = new Error("network not found") as Error & { statusCode: number };
                    err.statusCode = 404;
                    throw err;
                }
                net.members.add(Container);
            },
            remove: async () => {
                const net = networks.get(name);
                if (!net) throw notFound();
                // Docker refuses to drop a network that still has endpoints.
                if ([...net.members].some((m) => running.has(m))) {
                    const err = new Error("network has active endpoints") as Error & { statusCode: number };
                    err.statusCode = 403;
                    throw err;
                }
                networks.delete(name);
                removedNetworks.push(name);
            },
        }),
    } as unknown as Docker;

    return { docker, created, removed, running, oomKilled, networks, removedNetworks, labelsByName };
}

describe("docker createSandbox / teardown / isAlive", () => {
    test("createSandbox confines the container: dropped capabilities, no privilege escalation, non-root", async () => {
        const { docker, created } = stubDocker();

        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://cortex.example.com:443",
            sessionsBasePath: "/sessions",
            libStorePath: libRoot,
            docker,
            fetch: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
            registerSandbox: async () => {},
        });

        (
            await ops.createSandbox(
                {
                    runId: "run-1",
                    stepId: "step-a",
                    analysisId: "an-1",
                    childWorkflowId: "run-1-0",
                    resources: { cpu: 2, memoryGb: 4 },
                },
                mintSandboxIdentity("run-1"),
            )
        )._unsafeUnwrap();

        for (const container of [sandboxOf(created), gatewayOf(created)]) {
            expect(container?.capDrop).toEqual(["ALL"]);
            expect(container?.securityOpt).toEqual(["no-new-privileges"]);
            expect(container?.user).toBe("1000:1000");
        }
    });

    test("the sandbox is confined to an internal network and publishes no port", async () => {
        const { docker, created, networks } = stubDocker();

        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "http://host.docker.internal:53421",
            sessionsBasePath: "/sessions",
            docker,
            fetch: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
            registerSandbox: async () => {},
        });

        (
            await ops.createSandbox(
                { runId: "run-1", stepId: "step-a", analysisId: "an-1", childWorkflowId: "run-1-0", resources: { cpu: 2, memoryGb: 4 } },
                mintSandboxIdentity("run-1"),
            )
        )._unsafeUnwrap();

        expect(networks.get(NETWORK)?.internal).toBe(true);

        const sandbox = sandboxOf(created);
        expect(sandbox?.networkMode).toBe(NETWORK);
        // An internal network silently ignores port bindings, so publishing one here
        // would be a lie. `/exec` is reachable only through the gateway.
        expect(sandbox?.portBindings).toBeUndefined();
    });

    test("the gateway fronts the sandbox: loopback-only port, no callback secret, no mounts", async () => {
        const { docker, created } = stubDocker();

        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "http://host.docker.internal:53421",
            sessionsBasePath: "/sessions",
            docker,
            fetch: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
            registerSandbox: async () => {},
        });

        const ref = (
            await ops.createSandbox(
                { runId: "run-1", stepId: "step-a", analysisId: "an-1", childWorkflowId: "run-1-0", resources: { cpu: 2, memoryGb: 4 } },
                mintSandboxIdentity("run-1"),
            )
        )._unsafeUnwrap();

        const gateway = gatewayOf(created);
        expect(gateway?.name).toBe(`${ref.sandboxId}-gw`);
        expect(gateway?.cmd).toEqual(["sandbox-server", "gateway"]);
        expect(gateway?.image).toBe("sandbox-base:latest");

        // The published port carries `/exec`, which is unauthenticated: it must not
        // be reachable from anywhere but this host.
        expect(gateway?.portBindings?.["8765/tcp"]?.[0]?.HostIp).toBe("127.0.0.1");

        // Possession of the callback secret is enough to forge a signed completion.
        // The gateway moves bytes; it must never be able to mint a signature.
        const gatewayEnv = gateway?.env.join("\n") ?? "";
        expect(gatewayEnv).not.toContain("SANDBOX_CALLBACK_SECRET");
        expect(gatewayEnv).not.toContain(ref.callbackSecret);
        expect(gateway?.binds).toEqual([]);

        // Both legs are pinned: inbound to the sandbox, outbound to the real ingress.
        const gwEnvMap = Object.fromEntries(gateway!.env.map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]));
        expect(gwEnvMap.GATEWAY_INBOUND_TARGET).toBe(`${ref.sandboxId}:8765`);
        expect(gwEnvMap.GATEWAY_OUTBOUND_TARGET).toBe("host.docker.internal:53421");
    });

    test("the sandbox reaches the ingress only through the gateway, with scheme and hostname preserved", async () => {
        const { docker, created } = stubDocker();

        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            // A TLS upstream: the sandbox must still see the hostname the cert is for.
            cortexBaseUrl: "https://cortex.example.com:443",
            sessionsBasePath: "/sessions",
            docker,
            fetch: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
            registerSandbox: async () => {},
        });

        (
            await ops.createSandbox(
                { runId: "run-1", stepId: "step-a", analysisId: "an-1", childWorkflowId: "run-1-0", resources: { cpu: 2, memoryGb: 4 } },
                mintSandboxIdentity("run-1"),
            )
        )._unsafeUnwrap();

        const sandbox = sandboxOf(created);
        const envMap = Object.fromEntries(sandbox!.env.map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]));

        // Scheme and host survive; only the port moves to the gateway's outbound leg.
        expect(envMap.CORTEX_BASE_URL).toBe("https://cortex.example.com:8766");
        // …and that hostname resolves to the gateway, not the real host. A DNS alias
        // on the gateway would be the obvious alternative and is a trap: the gateway
        // is multi-homed and would resolve its own alias, forwarding to itself.
        expect(sandbox?.extraHosts).toEqual(["cortex.example.com:172.24.0.2"]);
    });

    test("siblings in one analysis share a network; a different analysis gets its own", async () => {
        const { docker, networks } = stubDocker();

        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "http://host.docker.internal:53421",
            sessionsBasePath: "/sessions",
            docker,
            fetch: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
            registerSandbox: async () => {},
        });

        const base = { runId: "run-1", childWorkflowId: "run-1-0", resources: { cpu: 1, memoryGb: 1 } };
        (await ops.createSandbox({ ...base, stepId: "step-a", analysisId: "an-1" }, mintSandboxIdentity("run-1")))._unsafeUnwrap();
        // The second create must tolerate the network already existing (409).
        (await ops.createSandbox({ ...base, stepId: "step-b", analysisId: "an-1" }, mintSandboxIdentity("run-1")))._unsafeUnwrap();
        (await ops.createSandbox({ ...base, stepId: "step-c", analysisId: "an-2" }, mintSandboxIdentity("run-1")))._unsafeUnwrap();

        expect([...networks.keys()].sort()).toEqual(["cortex-sbx-an-1", "cortex-sbx-an-2"]);
    });

    test("teardown removes the gateway with the sandbox and sweeps the empty network", async () => {
        const { docker, removed, removedNetworks } = stubDocker();

        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "http://host.docker.internal:53421",
            sessionsBasePath: "/sessions",
            docker,
            fetch: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
            registerSandbox: async () => {},
        });

        const ref = (
            await ops.createSandbox(
                { runId: "run-1", stepId: "step-a", analysisId: "an-1", childWorkflowId: "run-1-0", resources: { cpu: 1, memoryGb: 1 } },
                mintSandboxIdentity("run-1"),
            )
        )._unsafeUnwrap();

        (await ops.teardown(ref))._unsafeUnwrap();

        expect(removed).toContain(ref.sandboxId);
        expect(removed).toContain(`${ref.sandboxId}-gw`);
        // The gateway must go FIRST, the sandbox LAST: the reaper rediscovers orphans
        // by the sandbox's label, so a partial teardown that stops after the gateway
        // must leave the sandbox present to be retried. The reverse order would leak a
        // gateway the reaper cannot find.
        expect(removed.indexOf(`${ref.sandboxId}-gw`)).toBeLessThan(removed.indexOf(ref.sandboxId));
        // Left unswept, one internal network per analysis exhausts Docker's default
        // address pool after roughly thirty analyses.
        expect(removedNetworks).toEqual([NETWORK]);
    });

    test("a create that fails after the gateway is up takes the gateway and network with it", async () => {
        const { docker, removed, removedNetworks, networks } = stubDocker();

        // The gateway is created first; make the *sandbox* create fail.
        const realCreate = docker.createContainer.bind(docker);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrowly overriding one method on the stub
        (docker as any).createContainer = async (opts: { Labels?: Record<string, string> }) => {
            if (opts.Labels?.role === "sandbox") throw new Error("image pull failed");
            return realCreate(opts as never);
        };

        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "http://host.docker.internal:53421",
            sessionsBasePath: "/sessions",
            docker,
            fetch: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
            registerSandbox: async () => {},
        });

        const identity = mintSandboxIdentity("run-1");
        const result = await ops.createSandbox(
            { runId: "run-1", stepId: "step-a", analysisId: "an-1", childWorkflowId: "run-1-0", resources: { cpu: 1, memoryGb: 1 } },
            identity,
        );
        expect(result.isErr()).toBe(true);

        // The reaper enumerates orphans by `cortex/sandbox-id`, which the gateway
        // deliberately lacks — so an abandoned gateway would never be collected, and
        // its endpoint would pin the analysis network forever.
        expect(removed).toContain(`${identity.sandboxId}-gw`);
        expect(removedNetworks).toEqual([NETWORK]);
        expect(networks.has(NETWORK)).toBe(false);
    });

    test("teardown leaves the network alone while a sibling sandbox still holds it", async () => {
        const { docker, removedNetworks } = stubDocker();

        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "http://host.docker.internal:53421",
            sessionsBasePath: "/sessions",
            docker,
            fetch: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
            registerSandbox: async () => {},
        });

        const base = { runId: "run-1", childWorkflowId: "run-1-0", resources: { cpu: 1, memoryGb: 1 } };
        const a = (await ops.createSandbox({ ...base, stepId: "step-a", analysisId: "an-1" }, mintSandboxIdentity("run-1")))._unsafeUnwrap();
        (await ops.createSandbox({ ...base, stepId: "step-b", analysisId: "an-1" }, mintSandboxIdentity("run-1")))._unsafeUnwrap();

        (await ops.teardown(a))._unsafeUnwrap();

        expect(removedNetworks).toEqual([]);
    });

    test("createSandbox launches with required env vars and returns a SandboxRef with callbackSecret", async () => {
        const { docker, created } = stubDocker();
        const registered: Array<{ runId: string; stepId: string; sandboxId: string }> = [];

        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://cortex.example.com:443",
            sessionsBasePath: "/sessions",
            libStorePath: libRoot,
            refStorePath: "/host/refs",
            docker,
            fetch: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
            registerSandbox: async (meta, ref) => {
                registered.push({
                    runId: meta.runId,
                    stepId: meta.stepId,
                    sandboxId: ref.sandboxId,
                });
            },
        });

        const ref = (
            await ops.createSandbox(
                {
                    runId: "run-1",
                    stepId: "step-a",
                    analysisId: "an-1",
                    childWorkflowId: "run-1-0",
                    resources: { cpu: 2, memoryGb: 4 },
                },
                mintSandboxIdentity("run-1"),
            )
        )._unsafeUnwrap();

        expect(ref.backend).toBe("docker");
        expect(ref.host).toBe("127.0.0.1");
        expect(ref.port).toBe(32100);
        expect(ref.callbackSecret.length).toBeGreaterThan(40);

        expect(created).toHaveLength(2); // gateway + sandbox
        const envMap = Object.fromEntries(
            sandboxOf(created)!.env.map((e) => {
                const idx = e.indexOf("=");
                return [e.slice(0, idx), e.slice(idx + 1)];
            }),
        );
        expect(envMap.CORTEX_BASE_URL).toBe("https://cortex.example.com:8766");
        expect(envMap.SANDBOX_CALLBACK_SECRET).toBe(ref.callbackSecret);
        expect(envMap.PROVENANCE_WATCH_DIRS).toBe("/an-1");
        expect(envMap.R_LIBS_SITE).toContain("/mnt/libs/current/r/");

        expect(sandboxOf(created)!.workingDir).toBe("/an-1/runs/run-1/step-a");
        expect(sandboxOf(created)!.binds).toEqual([
            "/sessions/an-1:/an-1:ro",
            "/sessions/an-1/runs/run-1/step-a:/an-1/runs/run-1/step-a:rw",
            `${libRoot}:/mnt/libs:ro`,
            "/host/refs:/mnt/refs:ro",
        ]);

        expect(registered).toEqual([{ runId: "run-1", stepId: "step-a", sandboxId: ref.sandboxId }]);
    });

    test("lib-store-unset omits the /mnt/libs bind and lib-store env", async () => {
        const { docker, created } = stubDocker();
        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            sessionsBasePath: "/sessions",
            docker,
            fetch: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
            registerSandbox: async () => {},
        });

        (
            await ops.createSandbox(
                {
                    runId: "run-1",
                    stepId: "step-a",
                    analysisId: "an-1",
                    childWorkflowId: "run-1-0",
                    resources: { cpu: 2, memoryGb: 4 },
                },
                mintSandboxIdentity("run-1"),
            )
        )._unsafeUnwrap();

        const envMap = Object.fromEntries(
            sandboxOf(created)!.env.map((e) => {
                const idx = e.indexOf("=");
                return [e.slice(0, idx), e.slice(idx + 1)];
            }),
        );
        expect(sandboxOf(created)!.binds).toEqual(["/sessions/an-1:/an-1:ro", "/sessions/an-1/runs/run-1/step-a:/an-1/runs/run-1/step-a:rw"]);
        expect(sandboxOf(created)!.binds.some((b) => b.includes("/mnt/libs"))).toBe(false);
        expect(envMap.R_LIBS_SITE).toBeUndefined();
        expect(envMap.NODE_PATH).toBeUndefined();
        expect(envMap.PROVENANCE_WATCH_DIRS).toBe("/an-1");
    });

    test("forwards the configured platform into createContainer options", async () => {
        const { docker, created } = stubDocker();
        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            sessionsBasePath: "/sessions",
            platform: "linux/arm64",
            docker,
            fetch: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
            registerSandbox: async () => {},
        });

        (
            await ops.createSandbox(
                { runId: "run-1", stepId: "step-a", analysisId: "an-1", childWorkflowId: "run-1-0", resources: { cpu: 2, memoryGb: 4 } },
                mintSandboxIdentity("run-1"),
            )
        )._unsafeUnwrap();

        expect(sandboxOf(created)!.hasPlatformKey).toBe(true);
        expect(sandboxOf(created)!.platform).toBe("linux/arm64");
    });

    test("omits the platform key entirely when no platform is configured", async () => {
        const { docker, created } = stubDocker();
        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            sessionsBasePath: "/sessions",
            docker,
            fetch: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
            registerSandbox: async () => {},
        });

        (
            await ops.createSandbox(
                { runId: "run-1", stepId: "step-a", analysisId: "an-1", childWorkflowId: "run-1-0", resources: { cpu: 2, memoryGb: 4 } },
                mintSandboxIdentity("run-1"),
            )
        )._unsafeUnwrap();

        // Absent, not `platform: undefined` — the source spreads the key only when set, so a
        // default-platform host lets dockerode/Docker pick the daemon's native arch.
        expect(sandboxOf(created)!.hasPlatformKey).toBe(false);
        expect(sandboxOf(created)!.platform).toBeUndefined();
    });

    test("readOnly omits the rw step bind and pins WorkingDir to the RO tree", async () => {
        const { docker, created } = stubDocker();
        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            sessionsBasePath: "/sessions",
            libStorePath: libRoot,
            docker,
            fetch: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
            registerSandbox: async () => {},
        });

        (
            await ops.createSandbox(
                {
                    runId: "ephemeral",
                    stepId: "ephemeral",
                    analysisId: "an-1",
                    childWorkflowId: "ephemeral:x",
                    resources: { cpu: 2, memoryGb: 4 },
                    readOnly: true,
                },
                mintSandboxIdentity("ephemeral"),
            )
        )._unsafeUnwrap();

        // Only the RO tree + lib store mount — no rw step bind.
        expect(sandboxOf(created)!.binds).toEqual(["/sessions/an-1:/an-1:ro", `${libRoot}:/mnt/libs:ro`]);
        expect(sandboxOf(created)!.binds.some((b) => b.endsWith(":rw"))).toBe(false);
        // WorkingDir falls back to the RO tree root.
        expect(sandboxOf(created)!.workingDir).toBe("/an-1");
    });

    test("skips the /mnt/libs mount when the store's current pointer has vanished since boot (finding 4)", async () => {
        const { docker, created } = stubDocker();
        // libStorePath is set (baked at boot) but `current` is gone (a mid-session prune or
        // rm). Binding the missing source would make Docker auto-create a root-owned dir, so
        // the client must re-check at creation and skip the mount + lib-store env instead.
        await rm(join(libRoot, "current"), { force: true });

        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            sessionsBasePath: "/sessions",
            libStorePath: libRoot,
            docker,
            fetch: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
            registerSandbox: async () => {},
        });

        (
            await ops.createSandbox(
                { runId: "run-1", stepId: "step-a", analysisId: "an-1", childWorkflowId: "run-1-0", resources: { cpu: 2, memoryGb: 4 } },
                mintSandboxIdentity("run-1"),
            )
        )._unsafeUnwrap();

        const envMap = Object.fromEntries(
            sandboxOf(created)!.env.map((e) => {
                const idx = e.indexOf("=");
                return [e.slice(0, idx), e.slice(idx + 1)];
            }),
        );
        expect(sandboxOf(created)!.binds.some((b) => b.includes("/mnt/libs"))).toBe(false);
        expect(envMap.R_LIBS_SITE).toBeUndefined();
        expect(envMap.NODE_PATH).toBeUndefined();
    });

    test("logs a warning when a configured store is unusable at create time (finding 4 observability)", async () => {
        const { docker } = stubDocker();
        await rm(join(libRoot, "current"), { force: true }); // store degraded since boot
        const warnings: Array<{ obj: unknown; msg: string }> = [];

        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            sessionsBasePath: "/sessions",
            libStorePath: libRoot,
            docker,
            fetch: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
            logger: { info: () => {}, error: () => {}, warn: (obj: unknown, msg?: string) => warnings.push({ obj, msg: msg ?? "" }) },
            registerSandbox: async () => {},
        });

        (
            await ops.createSandbox(
                { runId: "run-1", stepId: "step-a", analysisId: "an-1", childWorkflowId: "run-1-0", resources: { cpu: 2, memoryGb: 4 } },
                mintSandboxIdentity("run-1"),
            )
        )._unsafeUnwrap();

        // The silent mount-drop now emits an operator-visible signal.
        expect(warnings).toHaveLength(1);
        expect(warnings[0]!.msg).toContain("lib store");
        expect(warnings[0]!.obj).toMatchObject({ libStorePath: libRoot });
    });

    test("skips the /mnt/libs mount when `current` is a DANGLING symlink to a pruned version (finding 5)", async () => {
        const { docker, created } = stubDocker();
        // `current` points at a version dir that no longer exists (pruned mid-session).
        await rm(join(libRoot, "2026.07.04-abc"), { recursive: true, force: true });

        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            sessionsBasePath: "/sessions",
            libStorePath: libRoot,
            docker,
            fetch: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
            registerSandbox: async () => {},
        });

        (
            await ops.createSandbox(
                { runId: "run-1", stepId: "step-a", analysisId: "an-1", childWorkflowId: "run-1-0", resources: { cpu: 2, memoryGb: 4 } },
                mintSandboxIdentity("run-1"),
            )
        )._unsafeUnwrap();

        expect(sandboxOf(created)!.binds.some((b) => b.includes("/mnt/libs"))).toBe(false);
    });

    test("skips the /mnt/libs mount when `current` resolves to an INCOMPLETE store (missing markers) (finding 5)", async () => {
        const { docker, created } = stubDocker();
        // A present `current` → dir, but the tree is missing packages.txt/meta.json (a
        // partially-extracted or corrupt store): existsSync(current) is true yet mounting
        // it would feed silently-broken content into the sandbox.
        await rm(join(libRoot, "2026.07.04-abc"), { recursive: true, force: true });
        await mkdir(join(libRoot, "2026.07.04-abc"), { recursive: true }); // dir back, but empty

        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            sessionsBasePath: "/sessions",
            libStorePath: libRoot,
            docker,
            fetch: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
            registerSandbox: async () => {},
        });

        (
            await ops.createSandbox(
                { runId: "run-1", stepId: "step-a", analysisId: "an-1", childWorkflowId: "run-1-0", resources: { cpu: 2, memoryGb: 4 } },
                mintSandboxIdentity("run-1"),
            )
        )._unsafeUnwrap();

        expect(sandboxOf(created)!.binds.some((b) => b.includes("/mnt/libs"))).toBe(false);
    });

    test("teardown of an already-gone container is a no-op success", async () => {
        const { docker } = stubDocker();
        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            sessionsBasePath: "/sessions",
            docker,
            registerSandbox: async () => {},
        });
        const result = await ops.teardown({
            sandboxId: "sbx-missing",
            host: "127.0.0.1",
            port: 9999,
            backend: "docker",
            callbackSecret: "x",
        });
        expect(result.isOk()).toBe(true);
    });

    test("isAlive returns false on 404 / not running and true on running", async () => {
        const { docker, running } = stubDocker();
        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            sessionsBasePath: "/sessions",
            docker,
            registerSandbox: async () => {},
        });

        expect(
            (
                await ops.isAlive({
                    sandboxId: "missing",
                    host: "h",
                    port: 1,
                    backend: "docker",
                    callbackSecret: "x",
                })
            )._unsafeUnwrap(),
        ).toEqual({ alive: false, oomKilled: false });

        running.set("alive", true);
        running.set("alive-gw", true);
        expect(
            (
                await ops.isAlive({
                    sandboxId: "alive",
                    host: "h",
                    port: 1,
                    backend: "docker",
                    callbackSecret: "x",
                })
            )._unsafeUnwrap(),
        ).toEqual({ alive: true, oomKilled: false });

        running.set("stopped", false);
        expect(
            (
                await ops.isAlive({
                    sandboxId: "stopped",
                    host: "h",
                    port: 1,
                    backend: "docker",
                    callbackSecret: "x",
                })
            )._unsafeUnwrap(),
        ).toEqual({ alive: false, oomKilled: false });
    });

    test("a gateway-fronted sandbox whose gateway is gone reports dead", async () => {
        const { docker, running, labelsByName } = stubDocker();
        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            sessionsBasePath: "/sessions",
            docker,
            registerSandbox: async () => {},
        });

        const ref = { sandboxId: "orphan", host: "h", port: 1, backend: "docker" as const, callbackSecret: "x" };
        // The analysis-id label is what marks a sandbox gateway-fronted.
        labelsByName.set("orphan", { "cortex/analysis-id": "an-1" });

        // The sandbox process still runs, but nothing can reach it and nothing it
        // sends can leave. Calling that "alive" leaves the watchdog waiting forever
        // on a recv that can never unblock.
        running.set("orphan", true);
        expect((await ops.isAlive(ref))._unsafeUnwrap()).toEqual({ alive: false, oomKilled: false });

        // A stopped gateway is no better than a missing one.
        running.set("orphan-gw", false);
        expect((await ops.isAlive(ref))._unsafeUnwrap()).toEqual({ alive: false, oomKilled: false });

        running.set("orphan-gw", true);
        expect((await ops.isAlive(ref))._unsafeUnwrap()).toEqual({ alive: true, oomKilled: false });
    });

    test("a pre-upgrade sandbox with no gateway is judged by its own liveness", async () => {
        const { docker, running } = stubDocker();
        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            sessionsBasePath: "/sessions",
            docker,
            registerSandbox: async () => {},
        });

        // A sandbox created before this topology shipped carries none of the new
        // labels and has no `-gw` container. Requiring a gateway of it would report
        // a running, reachable sandbox dead across a binary upgrade — lost work for
        // an in-flight run. It reaches the host through its own published port.
        const ref = { sandboxId: "legacy", host: "h", port: 1, backend: "docker" as const, callbackSecret: "x" };
        running.set("legacy", true);
        expect((await ops.isAlive(ref))._unsafeUnwrap()).toEqual({ alive: true, oomKilled: false });

        running.set("legacy", false);
        expect((await ops.isAlive(ref))._unsafeUnwrap()).toEqual({ alive: false, oomKilled: false });
    });

    test("isAlive reports an OOM-killed container as dead with the OOM cause", async () => {
        const { docker, running, oomKilled } = stubDocker();
        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            sessionsBasePath: "/sessions",
            docker,
            registerSandbox: async () => {},
        });

        running.set("oomed", false);
        oomKilled.add("oomed");
        expect(
            (
                await ops.isAlive({
                    sandboxId: "oomed",
                    host: "h",
                    port: 1,
                    backend: "docker",
                    callbackSecret: "x",
                })
            )._unsafeUnwrap(),
        ).toEqual({ alive: false, oomKilled: true });
    });

    test("isAlive errs on non-404 errors so callers can retry", async () => {
        const erroringDocker = {
            getContainer: () => ({
                inspect: async () => {
                    const err = new Error("server unavailable") as Error & {
                        statusCode: number;
                    };
                    err.statusCode = 503;
                    throw err;
                },
            }),
        } as unknown as Docker;

        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            sessionsBasePath: "/sessions",
            docker: erroringDocker,
            registerSandbox: async () => {},
        });

        const result = await ops.isAlive({
            sandboxId: "x",
            host: "h",
            port: 1,
            backend: "docker",
            callbackSecret: "x",
        });
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
            expect(result.error.type).toBe("liveness_failed");
        }
    });
});
