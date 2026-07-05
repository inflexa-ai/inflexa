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

interface StubContainer {
    id: string;
    start: () => Promise<void>;
    inspect: () => Promise<{
        NetworkSettings: { Ports: Record<string, Array<{ HostPort: string }>> };
        State: { Running: boolean };
    }>;
    stop: () => Promise<void>;
    remove: () => Promise<void>;
}

interface CreatedContainer {
    name: string;
    env: string[];
    binds: string[];
    workingDir?: string;
    platform?: string;
    /** Whether the `platform` key was present at all on createOpts — the config-unset case must OMIT it, not pass undefined. */
    hasPlatformKey: boolean;
}

function stubDocker(): {
    docker: Docker;
    created: CreatedContainer[];
    removed: string[];
    running: Map<string, boolean>;
    oomKilled: Set<string>;
} {
    const created: CreatedContainer[] = [];
    const removed: string[] = [];
    const running = new Map<string, boolean>();
    const oomKilled = new Set<string>();

    const makeContainer = (id: string): StubContainer => ({
        id,
        start: async () => {
            running.set(id, true);
        },
        inspect: async () => {
            if (!running.has(id)) {
                const err = new Error("no such container") as Error & {
                    statusCode: number;
                };
                err.statusCode = 404;
                throw err;
            }
            return {
                NetworkSettings: { Ports: { "8765/tcp": [{ HostPort: "32100" }] } },
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
        createContainer: async (opts: { name: string; Env: string[]; WorkingDir?: string; platform?: string; HostConfig?: { Binds?: string[] } }) => {
            created.push({
                name: opts.name,
                env: opts.Env,
                binds: opts.HostConfig?.Binds ?? [],
                workingDir: opts.WorkingDir,
                platform: opts.platform,
                hasPlatformKey: Object.prototype.hasOwnProperty.call(opts, "platform"),
            });
            return makeContainer(opts.name);
        },
        getContainer: (id: string) => makeContainer(id),
    } as unknown as Docker;

    return { docker, created, removed, running, oomKilled };
}

describe("docker createSandbox / teardown / isAlive", () => {
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

        expect(created).toHaveLength(1);
        const envMap = Object.fromEntries(
            created[0]!.env.map((e) => {
                const idx = e.indexOf("=");
                return [e.slice(0, idx), e.slice(idx + 1)];
            }),
        );
        expect(envMap.CORTEX_BASE_URL).toBe("https://cortex.example.com:443");
        expect(envMap.SANDBOX_CALLBACK_SECRET).toBe(ref.callbackSecret);
        expect(envMap.PROVENANCE_WATCH_DIRS).toBe("/an-1");
        expect(envMap.R_LIBS_SITE).toContain("/mnt/libs/current/r/");

        expect(created[0]!.workingDir).toBe("/an-1/runs/run-1/step-a");
        expect(created[0]!.binds).toEqual([
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
            created[0]!.env.map((e) => {
                const idx = e.indexOf("=");
                return [e.slice(0, idx), e.slice(idx + 1)];
            }),
        );
        expect(created[0]!.binds).toEqual(["/sessions/an-1:/an-1:ro", "/sessions/an-1/runs/run-1/step-a:/an-1/runs/run-1/step-a:rw"]);
        expect(created[0]!.binds.some((b) => b.includes("/mnt/libs"))).toBe(false);
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

        expect(created[0]!.hasPlatformKey).toBe(true);
        expect(created[0]!.platform).toBe("linux/arm64");
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
        expect(created[0]!.hasPlatformKey).toBe(false);
        expect(created[0]!.platform).toBeUndefined();
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
        expect(created[0]!.binds).toEqual(["/sessions/an-1:/an-1:ro", `${libRoot}:/mnt/libs:ro`]);
        expect(created[0]!.binds.some((b) => b.endsWith(":rw"))).toBe(false);
        // WorkingDir falls back to the RO tree root.
        expect(created[0]!.workingDir).toBe("/an-1");
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
            created[0]!.env.map((e) => {
                const idx = e.indexOf("=");
                return [e.slice(0, idx), e.slice(idx + 1)];
            }),
        );
        expect(created[0]!.binds.some((b) => b.includes("/mnt/libs"))).toBe(false);
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

        expect(created[0]!.binds.some((b) => b.includes("/mnt/libs"))).toBe(false);
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

        expect(created[0]!.binds.some((b) => b.includes("/mnt/libs"))).toBe(false);
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
        expect(result._unsafeUnwrapErr().type).toBe("liveness_failed");
    });
});
