/**
 * Per-backend createSandbox/teardown/isAlive tests against a mocked Docker
 * client. Covers the contract the SandboxClient factory wraps: the two transport
 * modes' container config, the loopback-published exec port, and container-only
 * liveness. There is no gateway sidecar and no `--internal` network.
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
// completeness markers (packages.txt + meta.json), not merely to exist, so tests that
// expect the /mnt/libs mount must point at a store that is actually usable.
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

interface CreatedContainer {
    name: string;
    image?: string;
    env: string[];
    binds: string[];
    labels?: Record<string, string>;
    workingDir?: string;
    platform?: string;
    /** Whether the `platform` key was present at all on createOpts — the config-unset case must OMIT it, not pass undefined. */
    hasPlatformKey: boolean;
    user?: string;
    capDrop?: string[];
    capAdd?: string[];
    securityOpt?: string[];
    portBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }>>;
}

interface CreateOpts {
    name: string;
    Image?: string;
    Env: string[];
    User?: string;
    WorkingDir?: string;
    platform?: string;
    Labels?: Record<string, string>;
    HostConfig?: {
        Binds?: string[];
        CapDrop?: string[];
        CapAdd?: string[];
        SecurityOpt?: string[];
        PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }>>;
    };
}

function notFound(): Error & { statusCode: number } {
    const err = new Error("no such container") as Error & { statusCode: number };
    err.statusCode = 404;
    return err;
}

/** The one sandbox container the ops create (there is no sidecar). */
function sandboxOf(created: CreatedContainer[]): CreatedContainer | undefined {
    return created.find((c) => c.labels?.role === "sandbox");
}

function envMapOf(container: CreatedContainer): Record<string, string> {
    return Object.fromEntries(
        container.env.map((e) => {
            const idx = e.indexOf("=");
            return [e.slice(0, idx), e.slice(idx + 1)];
        }),
    );
}

function stubDocker(): {
    docker: Docker;
    created: CreatedContainer[];
    removed: string[];
    running: Map<string, boolean>;
    oomKilled: Set<string>;
    createdNetworks: string[];
    /** Container name → labels its inspect reports. Seed directly to model a container not created through the ops. */
    labelsByName: Map<string, Record<string, string>>;
} {
    const created: CreatedContainer[] = [];
    const removed: string[] = [];
    const running = new Map<string, boolean>();
    const oomKilled = new Set<string>();
    const createdNetworks: string[] = [];
    const labelsByName = new Map<string, Record<string, string>>();

    const makeContainer = (id: string) => ({
        id,
        start: async () => {
            running.set(id, true);
        },
        inspect: async () => {
            if (!running.has(id)) throw notFound();
            // The sandbox publishes its own exec port to loopback — there is no gateway.
            return {
                Config: { Labels: labelsByName.get(id) ?? {} },
                NetworkSettings: {
                    Ports: { "8765/tcp": [{ HostIp: "127.0.0.1", HostPort: "32100" }] },
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
                env: opts.Env,
                binds: opts.HostConfig?.Binds ?? [],
                labels: opts.Labels,
                workingDir: opts.WorkingDir,
                platform: opts.platform,
                hasPlatformKey: Object.prototype.hasOwnProperty.call(opts, "platform"),
                user: opts.User,
                capDrop: opts.HostConfig?.CapDrop,
                capAdd: opts.HostConfig?.CapAdd,
                securityOpt: opts.HostConfig?.SecurityOpt,
                portBindings: opts.HostConfig?.PortBindings,
            });
            labelsByName.set(opts.name, opts.Labels ?? {});
            return makeContainer(opts.name);
        },
        getContainer: (id: string) => makeContainer(id),
        // The new topology creates no networks; a call here would be a regression.
        createNetwork: async (opts: { Name: string }) => {
            createdNetworks.push(opts.Name);
            return {};
        },
    } as unknown as Docker;

    return { docker, created, removed, running, oomKilled, createdNetworks, labelsByName };
}

const META = { runId: "run-1", stepId: "step-a", analysisId: "an-1", childWorkflowId: "run-1-0", resources: { cpu: 2, memoryGb: 4 } } as const;
const okFetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;

describe("docker createSandbox — transport modes", () => {
    test("poll mode (default): root entrypoint with NET_ADMIN + firewall flag, no CORTEX_BASE_URL", async () => {
        const { docker, created } = stubDocker();
        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://cortex.example.com:443",
            resolveWorkspaceRoot: (id) => join("/sessions", id),
            docker,
            fetch: okFetch,
            registerSandbox: async () => {},
        });

        (await ops.createSandbox(META, mintSandboxIdentity("run-1")))._unsafeUnwrap();

        const sandbox = sandboxOf(created)!;
        expect(sandbox.capDrop).toEqual(["ALL"]);
        expect(sandbox.securityOpt).toEqual(["no-new-privileges"]);
        // Poll mode starts as root so the entrypoint can install the firewall, then
        // NET_ADMIN is granted for exactly that — the entrypoint `setpriv`-drops after.
        expect(sandbox.user).toBe("0:0");
        expect(sandbox.capAdd).toEqual(["NET_ADMIN"]);

        const env = envMapOf(sandbox);
        expect(env.SANDBOX_TRANSPORT).toBe("poll");
        expect(env.SANDBOX_EGRESS_FIREWALL).toBe("1");
        // Poll mode never dials out — a CORTEX_BASE_URL would be meaningless.
        expect(env.CORTEX_BASE_URL).toBeUndefined();
    });

    test("callback mode: uid 1000 throughout, egress permitted, CORTEX_BASE_URL set", async () => {
        const { docker, created } = stubDocker();
        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://cortex.example.com:443",
            transport: "callback",
            resolveWorkspaceRoot: (id) => join("/sessions", id),
            docker,
            fetch: okFetch,
            registerSandbox: async () => {},
        });

        (await ops.createSandbox(META, mintSandboxIdentity("run-1")))._unsafeUnwrap();

        const sandbox = sandboxOf(created)!;
        expect(sandbox.user).toBe("1000:1000");
        expect(sandbox.capDrop).toEqual(["ALL"]);
        // No firewall in callback mode: egress is permitted so callbacks can leave.
        expect(sandbox.capAdd).toBeUndefined();

        const env = envMapOf(sandbox);
        expect(env.SANDBOX_TRANSPORT).toBe("callback");
        expect(env.SANDBOX_EGRESS_FIREWALL).toBeUndefined();
        expect(env.CORTEX_BASE_URL).toBe("https://cortex.example.com:443");
    });

    test("the exec port is published to loopback only, and no gateway or network is created", async () => {
        const { docker, created, createdNetworks } = stubDocker();
        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            resolveWorkspaceRoot: (id) => join("/sessions", id),
            docker,
            fetch: okFetch,
            registerSandbox: async () => {},
        });

        const ref = (await ops.createSandbox(META, mintSandboxIdentity("run-1")))._unsafeUnwrap();

        // Exactly one container — no sidecar.
        expect(created).toHaveLength(1);
        expect(createdNetworks).toEqual([]);

        const binding = sandboxOf(created)!.portBindings?.["8765/tcp"]?.[0];
        expect(binding?.HostIp).toBe("127.0.0.1");
        // The SandboxRef carries the mapped host port the daemon assigned.
        expect(ref.host).toBe("127.0.0.1");
        expect(ref.port).toBe(32100);
    });

    test("returns a SandboxRef with callbackSecret and registers it; env + binds are wired", async () => {
        const { docker, created } = stubDocker();
        const registered: Array<{ runId: string; stepId: string; sandboxId: string }> = [];
        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            resolveWorkspaceRoot: (id) => join("/sessions", id),
            libStorePath: libRoot,
            refStorePath: "/host/refs",
            docker,
            fetch: okFetch,
            registerSandbox: async (meta, ref) => {
                registered.push({ runId: meta.runId, stepId: meta.stepId, sandboxId: ref.sandboxId });
            },
        });

        const ref = (await ops.createSandbox(META, mintSandboxIdentity("run-1")))._unsafeUnwrap();

        expect(ref.backend).toBe("docker");
        expect(ref.callbackSecret.length).toBeGreaterThan(40);

        const sandbox = sandboxOf(created)!;
        const env = envMapOf(sandbox);
        expect(env.SANDBOX_CALLBACK_SECRET).toBe(ref.callbackSecret);
        expect(env.PROVENANCE_WATCH_DIRS).toBe("/an-1");
        expect(env.R_LIBS_SITE).toContain("/mnt/libs/current/r/");

        expect(sandbox.workingDir).toBe("/an-1/runs/run-1/step-a");
        expect(sandbox.binds).toEqual([
            "/sessions/an-1:/an-1:ro",
            "/sessions/an-1/runs/run-1/step-a:/an-1/runs/run-1/step-a:rw",
            `${libRoot}:/mnt/libs:ro`,
            "/host/refs:/mnt/refs:ro",
        ]);
        expect(registered).toEqual([{ runId: "run-1", stepId: "step-a", sandboxId: ref.sandboxId }]);
    });

    test("a container that maps no host port is stopped, removed, and reported failed", async () => {
        const { docker, removed } = stubDocker();
        // A daemon that starts the container but publishes no port for 8765/tcp.
        (docker as unknown as { getContainer: (id: string) => unknown }).getContainer = (id: string) => ({
            id,
            start: async () => {},
            stop: async () => {},
            remove: async () => {
                removed.push(id);
            },
            inspect: async () => ({ Config: { Labels: {} }, NetworkSettings: { Ports: {} }, State: { Running: true } }),
        });
        (docker as unknown as { createContainer: (o: CreateOpts) => unknown }).createContainer = async (opts: CreateOpts) => ({
            id: opts.name,
            start: async () => {},
            stop: async () => {},
            remove: async () => {
                removed.push(opts.name);
            },
            inspect: async () => ({ Config: { Labels: {} }, NetworkSettings: { Ports: {} }, State: { Running: true } }),
        });

        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            resolveWorkspaceRoot: (id) => join("/sessions", id),
            docker,
            fetch: okFetch,
            registerSandbox: async () => {},
        });

        const result = await ops.createSandbox(META, mintSandboxIdentity("run-1"));
        expect(result.isErr()).toBe(true);
        if (result.isErr()) expect(result.error.type).toBe("container_create_failed");
        expect(removed.length).toBeGreaterThan(0);
    });
});

describe("docker createSandbox — mounts and platform", () => {
    test("lib-store-unset omits the /mnt/libs bind and lib-store env", async () => {
        const { docker, created } = stubDocker();
        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            resolveWorkspaceRoot: (id) => join("/sessions", id),
            docker,
            fetch: okFetch,
            registerSandbox: async () => {},
        });

        (await ops.createSandbox(META, mintSandboxIdentity("run-1")))._unsafeUnwrap();

        const sandbox = sandboxOf(created)!;
        const env = envMapOf(sandbox);
        expect(sandbox.binds).toEqual(["/sessions/an-1:/an-1:ro", "/sessions/an-1/runs/run-1/step-a:/an-1/runs/run-1/step-a:rw"]);
        expect(sandbox.binds.some((b) => b.includes("/mnt/libs"))).toBe(false);
        expect(env.R_LIBS_SITE).toBeUndefined();
        expect(env.NODE_PATH).toBeUndefined();
        expect(env.PROVENANCE_WATCH_DIRS).toBe("/an-1");
    });

    test("forwards the configured platform into createContainer options", async () => {
        const { docker, created } = stubDocker();
        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            resolveWorkspaceRoot: (id) => join("/sessions", id),
            platform: "linux/arm64",
            docker,
            fetch: okFetch,
            registerSandbox: async () => {},
        });

        (await ops.createSandbox(META, mintSandboxIdentity("run-1")))._unsafeUnwrap();

        expect(sandboxOf(created)!.hasPlatformKey).toBe(true);
        expect(sandboxOf(created)!.platform).toBe("linux/arm64");
    });

    test("omits the platform key entirely when no platform is configured", async () => {
        const { docker, created } = stubDocker();
        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            resolveWorkspaceRoot: (id) => join("/sessions", id),
            docker,
            fetch: okFetch,
            registerSandbox: async () => {},
        });

        (await ops.createSandbox(META, mintSandboxIdentity("run-1")))._unsafeUnwrap();

        expect(sandboxOf(created)!.hasPlatformKey).toBe(false);
        expect(sandboxOf(created)!.platform).toBeUndefined();
    });

    test("readOnly omits the rw step bind and pins WorkingDir to the RO tree", async () => {
        const { docker, created } = stubDocker();
        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            resolveWorkspaceRoot: (id) => join("/sessions", id),
            libStorePath: libRoot,
            docker,
            fetch: okFetch,
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

        expect(sandboxOf(created)!.binds).toEqual(["/sessions/an-1:/an-1:ro", `${libRoot}:/mnt/libs:ro`]);
        expect(sandboxOf(created)!.binds.some((b) => b.endsWith(":rw"))).toBe(false);
        expect(sandboxOf(created)!.workingDir).toBe("/an-1");
    });

    test("skips the /mnt/libs mount when the store's current pointer has vanished since boot", async () => {
        const { docker, created } = stubDocker();
        await rm(join(libRoot, "current"), { force: true });

        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            resolveWorkspaceRoot: (id) => join("/sessions", id),
            libStorePath: libRoot,
            docker,
            fetch: okFetch,
            registerSandbox: async () => {},
        });

        (await ops.createSandbox(META, mintSandboxIdentity("run-1")))._unsafeUnwrap();

        const env = envMapOf(sandboxOf(created)!);
        expect(sandboxOf(created)!.binds.some((b) => b.includes("/mnt/libs"))).toBe(false);
        expect(env.R_LIBS_SITE).toBeUndefined();
    });

    test("logs a warning when a configured store is unusable at create time", async () => {
        const { docker } = stubDocker();
        await rm(join(libRoot, "current"), { force: true });
        const warnings: Array<{ obj: unknown; msg: string }> = [];

        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            resolveWorkspaceRoot: (id) => join("/sessions", id),
            libStorePath: libRoot,
            docker,
            fetch: okFetch,
            logger: { info: () => {}, error: () => {}, warn: (obj: unknown, msg?: string) => warnings.push({ obj, msg: msg ?? "" }) },
            registerSandbox: async () => {},
        });

        (await ops.createSandbox(META, mintSandboxIdentity("run-1")))._unsafeUnwrap();

        expect(warnings).toHaveLength(1);
        expect(warnings[0]!.msg).toContain("lib store");
        expect(warnings[0]!.obj).toMatchObject({ libStorePath: libRoot });
    });

    test("skips the /mnt/libs mount when `current` is a dangling symlink to a pruned version", async () => {
        const { docker, created } = stubDocker();
        await rm(join(libRoot, "2026.07.04-abc"), { recursive: true, force: true });

        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            resolveWorkspaceRoot: (id) => join("/sessions", id),
            libStorePath: libRoot,
            docker,
            fetch: okFetch,
            registerSandbox: async () => {},
        });

        (await ops.createSandbox(META, mintSandboxIdentity("run-1")))._unsafeUnwrap();

        expect(sandboxOf(created)!.binds.some((b) => b.includes("/mnt/libs"))).toBe(false);
    });
});

describe("docker teardown / isAlive", () => {
    test("teardown removes the container", async () => {
        const { docker, removed } = stubDocker();
        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            resolveWorkspaceRoot: (id) => join("/sessions", id),
            docker,
            fetch: okFetch,
            registerSandbox: async () => {},
        });

        const ref = (await ops.createSandbox(META, mintSandboxIdentity("run-1")))._unsafeUnwrap();
        (await ops.teardown(ref))._unsafeUnwrap();
        expect(removed).toContain(ref.sandboxId);
    });

    test("teardown of an already-gone container is a no-op success", async () => {
        const { docker } = stubDocker();
        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            resolveWorkspaceRoot: (id) => join("/sessions", id),
            docker,
            registerSandbox: async () => {},
        });
        const result = await ops.teardown({ sandboxId: "sbx-missing", host: "127.0.0.1", port: 9999, backend: "docker", callbackSecret: "x" });
        expect(result.isOk()).toBe(true);
    });

    test("isAlive is the container's liveness: running→alive, stopped/404→dead", async () => {
        const { docker, running } = stubDocker();
        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            resolveWorkspaceRoot: (id) => join("/sessions", id),
            docker,
            registerSandbox: async () => {},
        });

        // 404 (never created) → dead.
        expect((await ops.isAlive({ sandboxId: "missing", host: "h", port: 1, backend: "docker", callbackSecret: "x" }))._unsafeUnwrap()).toEqual({
            alive: false,
            oomKilled: false,
        });

        running.set("alive", true);
        expect((await ops.isAlive({ sandboxId: "alive", host: "h", port: 1, backend: "docker", callbackSecret: "x" }))._unsafeUnwrap()).toEqual({
            alive: true,
            oomKilled: false,
        });

        running.set("stopped", false);
        expect((await ops.isAlive({ sandboxId: "stopped", host: "h", port: 1, backend: "docker", callbackSecret: "x" }))._unsafeUnwrap()).toEqual({
            alive: false,
            oomKilled: false,
        });
    });

    test("isAlive reports an OOM-killed container as dead with the OOM cause", async () => {
        const { docker, running, oomKilled } = stubDocker();
        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            resolveWorkspaceRoot: (id) => join("/sessions", id),
            docker,
            registerSandbox: async () => {},
        });

        running.set("oomed", false);
        oomKilled.add("oomed");
        expect((await ops.isAlive({ sandboxId: "oomed", host: "h", port: 1, backend: "docker", callbackSecret: "x" }))._unsafeUnwrap()).toEqual({
            alive: false,
            oomKilled: true,
        });
    });

    test("isAlive errs on non-404 errors so callers can retry", async () => {
        const erroringDocker = {
            getContainer: () => ({
                inspect: async () => {
                    const err = new Error("server unavailable") as Error & { statusCode: number };
                    err.statusCode = 503;
                    throw err;
                },
            }),
        } as unknown as Docker;

        const ops = createDockerSandboxOps({
            image: "sandbox-base:latest",
            cortexBaseUrl: "https://x",
            resolveWorkspaceRoot: (id) => join("/sessions", id),
            docker: erroringDocker,
            registerSandbox: async () => {},
        });

        const result = await ops.isAlive({ sandboxId: "x", host: "h", port: 1, backend: "docker", callbackSecret: "x" });
        expect(result.isErr()).toBe(true);
        if (result.isErr()) expect(result.error.type).toBe("liveness_failed");
    });
});
