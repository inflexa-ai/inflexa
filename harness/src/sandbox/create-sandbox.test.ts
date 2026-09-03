/**
 * Unit tests for the client's awaitExec option assembly: the liveness probe
 * self-wires from the backend ops, explicit seam injections win, and the
 * transport is client-owned. Pure composition — no DBOS, no backend.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";

import { errAsync } from "neverthrow";

import type { AwaitExecOptions } from "./await-exec.js";
import { composeAwaitOptions, createSandboxClient, precreateStepTree } from "./create-sandbox.js";
import * as dockerClient from "./docker-client.js";
import { mintSandboxIdentity } from "./identity.js";
import * as k8sClient from "./k8s-client.js";
import { SandboxFailure as BarrelSandboxFailure } from "@inflexa-ai/harness";
import { createNoopLogger } from "../lib/console-logger.js";
import { STEP_SUBDIRS } from "./mount-plan.js";
import { describeSandboxError, SandboxFailure, type SandboxError } from "./sandbox-error.js";
import type { CreateSandboxMeta, FarmSource, SandboxLiveness } from "./types.js";

const opsProbe = async (): Promise<SandboxLiveness> => ({ alive: false, oomKilled: false });
const injectedProbe = async (): Promise<SandboxLiveness> => ({ alive: true, oomKilled: false });

describe("composeAwaitOptions", () => {
    test("self-wires the backend probe when the caller injects none", () => {
        const options = composeAwaitOptions(undefined, "poll", opsProbe);
        expect(options.isAlive).toBe(opsProbe);
        expect(options.transport).toBe("poll");
    });

    test("an explicitly injected probe seam wins over the self-wired one", () => {
        const base: AwaitExecOptions = { isAlive: injectedProbe };
        const options = composeAwaitOptions(base, "poll", opsProbe);
        expect(options.isAlive).toBe(injectedProbe);
    });

    test("the transport is client-owned — a base transport cannot override it", () => {
        const base: AwaitExecOptions = { transport: "callback" };
        const options = composeAwaitOptions(base, "poll", opsProbe);
        expect(options.transport).toBe("poll");
    });

    test("other injected seams pass through untouched", () => {
        const sleep = async () => {};
        const options = composeAwaitOptions({ sleep }, "callback", opsProbe);
        expect(options.sleep).toBe(sleep);
        expect(options.transport).toBe("callback");
        expect(options.isAlive).toBe(opsProbe);
    });
});

describe("precreateStepTree — step-tree access mode", () => {
    let root: string;
    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "harness-steptree-"));
    });
    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    const meta: CreateSandboxMeta = {
        runId: "run-1",
        stepId: "step-a",
        analysisId: "an-1",
        childWorkflowId: "run-1-0",
        resources: { cpu: 1, memoryGb: 1 },
    };
    const deps = (stepTreeAccess?: "world-writable") => ({ resolveWorkspaceRoot: () => root, stepTreeAccess });
    const stepDir = () => join(root, "runs", "run-1", "step-a");
    /** POSIX permission bits, with the file-type bits masked off. */
    const modeOf = async (p: string): Promise<number> => (await stat(p)).mode & 0o777;

    test("world-writable: a fresh step tree ends world-writable across the dir and its subdirs", async () => {
        await precreateStepTree(deps("world-writable"), meta);

        expect(await modeOf(stepDir())).toBe(0o777);
        for (const sub of STEP_SUBDIRS) {
            expect(await modeOf(join(stepDir(), sub))).toBe(0o777);
        }
        // The loosening is scoped to the step tree — its ancestors keep default modes.
        expect(await modeOf(join(root, "runs"))).not.toBe(0o777);
    });

    test("world-writable: a pre-existing step tree left with default modes is re-moded on replay", async () => {
        // A prior attempt: the dirs already stand with a non-world-writable mode.
        await mkdir(stepDir(), { recursive: true, mode: 0o700 });
        await Promise.all(STEP_SUBDIRS.map((sub) => mkdir(join(stepDir(), sub), { recursive: true, mode: 0o700 })));
        expect(await modeOf(stepDir())).not.toBe(0o777);

        await precreateStepTree(deps("world-writable"), meta);

        expect(await modeOf(stepDir())).toBe(0o777);
        for (const sub of STEP_SUBDIRS) {
            expect(await modeOf(join(stepDir(), sub))).toBe(0o777);
        }
    });

    test("unset: step-tree modes match a plain mkdir — no world-write loosening", async () => {
        await precreateStepTree(deps(undefined), meta);

        // Control for this process's umask: what a bare recursive mkdir yields.
        const control = join(root, "control");
        await mkdir(control, { recursive: true });
        const defaultMode = await modeOf(control);

        expect(await modeOf(stepDir())).toBe(defaultMode);
        for (const sub of STEP_SUBDIRS) {
            expect(await modeOf(join(stepDir(), sub))).toBe(defaultMode);
        }
    });

    test("read-only meta pre-creates nothing to re-mode", async () => {
        await precreateStepTree(deps("world-writable"), { ...meta, readOnly: true });

        // The read-only path returns before creating or chmodding any step tree.
        await expect(stat(stepDir())).rejects.toThrow();
    });

    /** A declared write tail, in the shape the session derivation gives. */
    const TAIL = "report-sessions/thread-1/derived";
    const tailDir = () => join(root, "report-sessions", "thread-1", "derived");

    test("a declared tail makes that one directory, and no step tree", async () => {
        await precreateStepTree(deps(undefined), { ...meta, writableTail: TAIL });

        expect((await stat(tailDir())).isDirectory()).toBe(true);
        // A declared tail is one directory, thus no artifact subdirectory lands under it.
        for (const sub of STEP_SUBDIRS) {
            await expect(stat(join(tailDir(), sub))).rejects.toThrow();
        }
        // The step tree of the coordinates is never made, because the tail took its place.
        await expect(stat(stepDir())).rejects.toThrow();
    });

    test("world-writable: a declared tail ends world-writable", async () => {
        await precreateStepTree(deps("world-writable"), { ...meta, writableTail: TAIL });

        expect(await modeOf(tailDir())).toBe(0o777);
        // The loosening is scoped to the tail — its ancestors keep default modes.
        expect(await modeOf(join(root, "report-sessions"))).not.toBe(0o777);
    });

    test("a crafted tail escapes nothing, because the builder refuses it first", async () => {
        await expect(precreateStepTree(deps(undefined), { ...meta, writableTail: "../escape" })).rejects.toThrow(/Invalid writableTail/);
        await expect(precreateStepTree(deps(undefined), { ...meta, writableTail: TAIL, readOnly: true })).rejects.toThrow(/read-only sandbox cannot/);
        await expect(stat(join(root, "..", "escape"))).rejects.toThrow();
    });
});

describe("createSandboxClient — the k8s libs root threading", () => {
    test("libStorePvcRoot reaches the k8s ops, so the host-side lock gate can run", () => {
        // The forward is one optional field: tsc cannot catch its absence, and
        // under a `fixed` farm source it carries the ONLY lock gate. The spy
        // asserts the composed backend config instead of faking a cluster,
        // because the factory forwards no test API seams.
        const logger = createNoopLogger();
        let captured: k8sClient.K8sClientConfig | null = null;
        const spy = spyOn(k8sClient, "createK8sSandboxOps").mockImplementation((cfg) => {
            captured = cfg;
            // The client is never used — the test ends at the composed config.
            return {} as unknown as ReturnType<typeof k8sClient.createK8sSandboxOps>;
        });
        try {
            createSandboxClient({
                pool: {} as unknown as Pool,
                env: { backend: "k8s", namespace: "sandbox" },
                cortexBaseUrl: "https://x",
                image: "sandbox-base:latest",
                resourceLimits: { maxCpu: 8, maxMemoryGb: 32, maxGpuCount: 0 },
                resolveWorkspaceRoot: (id) => join("/sessions", id),
                sessionPvc: "cortex-sessions",
                sessionPvcRoot: "/sessions",
                libStorePvc: "cortex-libs",
                libStorePvcRoot: "/mnt/libs",
                farmSource: { kind: "fixed", location: { farmPath: "farms/catalog" } },
                logger,
            });

            expect(captured).not.toBeNull();
            expect(captured!.libStorePvcRoot).toBe("/mnt/libs");
            expect(captured!.libStorePvc).toBe("cortex-libs");
            // The same reference, not a copy: the lock-gate warning must reach
            // the embedder's sink, never the no-op fallback.
            expect(captured!.logger).toBe(logger);
        } finally {
            spy.mockRestore();
        }
    });
});

describe("createSandboxClient — the required-store fact", () => {
    const FIXED: FarmSource = { kind: "fixed", location: { farmPath: "farms/catalog" } };
    const base = {
        pool: {} as unknown as Pool,
        cortexBaseUrl: "https://x",
        image: "sandbox-base:latest",
        resourceLimits: { maxCpu: 8, maxMemoryGb: 32, maxGpuCount: 0 },
        resolveWorkspaceRoot: (id: string) => join("/sessions", id),
    };

    test("the fact reaches both backend ops, so each gate can refuse instead of degrade", () => {
        // One optional field on each backend config: tsc cannot catch its
        // absence, and without the forward the gate silently keeps degrading.
        let k8sConfig: k8sClient.K8sClientConfig | null = null;
        let dockerConfig: dockerClient.DockerClientConfig | null = null;
        const k8sSpy = spyOn(k8sClient, "createK8sSandboxOps").mockImplementation((cfg) => {
            k8sConfig = cfg;
            return {} as unknown as ReturnType<typeof k8sClient.createK8sSandboxOps>;
        });
        const dockerSpy = spyOn(dockerClient, "createDockerSandboxOps").mockImplementation((cfg) => {
            dockerConfig = cfg;
            return {} as unknown as ReturnType<typeof dockerClient.createDockerSandboxOps>;
        });
        try {
            createSandboxClient({
                ...base,
                env: { backend: "k8s", namespace: "sandbox" },
                sessionPvc: "cortex-sessions",
                sessionPvcRoot: "/sessions",
                libStorePvc: "cortex-libs",
                libStorePvcRoot: "/mnt/libs",
                farmSource: FIXED,
                packageStore: "required",
            });
            createSandboxClient({
                ...base,
                env: { backend: "docker", namespace: "default" },
                libStorePath: "/mnt/libs",
                farmSource: FIXED,
                packageStore: "required",
            });

            expect(k8sConfig).not.toBeNull();
            expect(k8sConfig!.packageStore).toBe("required");
            expect(dockerConfig).not.toBeNull();
            expect(dockerConfig!.packageStore).toBe("required");
        } finally {
            k8sSpy.mockRestore();
            dockerSpy.mockRestore();
        }
    });

    test("a docker client with no lib store cannot prove the fact, and composition refuses", () => {
        expect(() =>
            createSandboxClient({
                ...base,
                env: { backend: "docker", namespace: "default" },
                farmSource: FIXED,
                packageStore: "required",
            }),
        ).toThrow(/libStorePath/);
    });

    test("a k8s client with no libs PVC cannot prove the fact, and composition refuses", () => {
        expect(() =>
            createSandboxClient({
                ...base,
                env: { backend: "k8s", namespace: "sandbox" },
                sessionPvc: "cortex-sessions",
                sessionPvcRoot: "/sessions",
                farmSource: FIXED,
                packageStore: "required",
            }),
        ).toThrow(/libStorePvc/);
    });

    test("a k8s fixed farm source with no libs mountpoint has no gate at all, and composition refuses", () => {
        expect(() =>
            createSandboxClient({
                ...base,
                env: { backend: "k8s", namespace: "sandbox" },
                sessionPvc: "cortex-sessions",
                sessionPvcRoot: "/sessions",
                libStorePvc: "cortex-libs",
                farmSource: FIXED,
                packageStore: "required",
            }),
        ).toThrow(/libStorePvcRoot/);
    });

    test("a k8s per-analysis source with no libs mountpoint composes, because the resolver owes the proof", () => {
        const spy = spyOn(k8sClient, "createK8sSandboxOps").mockImplementation(() => ({}) as unknown as ReturnType<typeof k8sClient.createK8sSandboxOps>);
        try {
            expect(() =>
                createSandboxClient({
                    ...base,
                    env: { backend: "k8s", namespace: "sandbox" },
                    sessionPvc: "cortex-sessions",
                    sessionPvcRoot: "/sessions",
                    libStorePvc: "cortex-libs",
                    farmSource: { kind: "per-analysis", resolve: async () => ({ kind: "available", location: { farmPath: "farms/an-1" } }) },
                    packageStore: "required",
                }),
            ).not.toThrow();
        } finally {
            spy.mockRestore();
        }
    });
});

describe("createSandboxClient — the seam throw", () => {
    test("a backend refusal reaches the caller as a SandboxFailure carrying the description and the variant", async () => {
        const root = await mkdtemp(join(tmpdir(), "harness-seam-"));
        const variant: SandboxError = {
            type: "farm_unusable",
            op: "docker.createSandbox",
            analysisId: "an-1",
            farmPath: "/mnt/libs/farms/catalog",
            lockPath: "/mnt/libs/farms/catalog/inflexa.lock",
            lockError: "lock_invalid",
            cause: new Error("Unexpected token o in JSON at position 1"),
        };
        const spy = spyOn(dockerClient, "createDockerSandboxOps").mockImplementation(
            () => ({ createSandbox: () => errAsync(variant) }) as unknown as ReturnType<typeof dockerClient.createDockerSandboxOps>,
        );
        try {
            const client = createSandboxClient({
                pool: {} as unknown as Pool,
                env: { backend: "docker", namespace: "default" },
                cortexBaseUrl: "https://x",
                image: "sandbox-base:latest",
                resourceLimits: { maxCpu: 8, maxMemoryGb: 32, maxGpuCount: 0 },
                resolveWorkspaceRoot: () => root,
                libStorePath: "/mnt/libs",
                farmSource: { kind: "fixed", location: { farmPath: "/mnt/libs/farms/catalog" } },
                packageStore: "required",
            });

            const thrown = await client
                .createSandbox(
                    { runId: "run-1", stepId: "step-a", analysisId: "an-1", childWorkflowId: "run-1-0", resources: { cpu: 1, memoryGb: 1 } },
                    mintSandboxIdentity("run-1"),
                )
                .then(
                    () => null,
                    (e: unknown) => e,
                );

            expect(thrown).toBeInstanceOf(SandboxFailure);
            // The barrel hands an embedder the same class, thus its `instanceof`
            // holds without a deep import.
            expect(thrown).toBeInstanceOf(BarrelSandboxFailure);
            const failure = thrown as SandboxFailure;
            // The message is the whole description — the head and the reason of
            // the cause — not the bare `type` a `ResultError` would render.
            expect(failure.message).toBe(describeSandboxError(variant));
            expect(failure.message).toContain("Unexpected token o in JSON");
            expect(failure.cause).toBe(variant);
            expect(failure.error).toBe(variant);
        } finally {
            spy.mockRestore();
            await rm(root, { recursive: true, force: true });
        }
    });
});

describe("createSandboxClient — engine connection threading", () => {
    test("engineSocketPath is threaded to the docker ops, so engine calls dial that socket", async () => {
        const dir = await mkdtemp(join(tmpdir(), "harness-engine-"));
        const socketPath = join(dir, "engine.sock");
        // A stand-in engine on the configured socket that answers the managed-
        // sandbox listing with one sentinel container. If the socket were not
        // threaded, the ops would dial the default engine and never see it.
        const server = createServer((_req, res) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify([{ Labels: { "cortex/sandbox-id": "sentinel-sbx", "cortex/owner-workflow-id": "wf-x" }, Created: 1700 }]));
        });
        await new Promise<void>((resolve) => server.listen(socketPath, resolve));

        try {
            const client = createSandboxClient({
                pool: {} as unknown as Pool,
                env: { backend: "docker", namespace: "default" },
                cortexBaseUrl: "https://x",
                image: "sandbox-base:latest",
                resourceLimits: { maxCpu: 8, maxMemoryGb: 32, maxGpuCount: 0 },
                resolveWorkspaceRoot: (id) => join("/sessions", id),
                engineSocketPath: socketPath,
            });

            const managed = await client.listManagedSandboxes();

            expect(managed).toEqual([{ sandboxId: "sentinel-sbx", ownerWorkflowId: "wf-x", createdAtMs: 1700000 }]);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe("createSandboxClient — the toolchain on the client", () => {
    const base = {
        pool: {} as unknown as Pool,
        env: { backend: "docker" as const, namespace: "" },
        cortexBaseUrl: "http://127.0.0.1:0",
        image: "sandbox-base:latest",
        resourceLimits: { maxCpu: 8, maxMemoryGb: 32, maxGpuCount: 0 },
        resolveWorkspaceRoot: (id: string) => join("/sessions", id),
        farmSource: { kind: "fixed", location: { farmPath: "/store/farms/catalog" } } as const,
    };

    test("an absent declaration reads as store on the client", () => {
        expect(createSandboxClient(base).toolchainSource).toBe("store");
    });

    test("the declared image toolchain reaches the client", () => {
        expect(createSandboxClient({ ...base, toolchainSource: "image" }).toolchainSource).toBe("image");
    });
});
