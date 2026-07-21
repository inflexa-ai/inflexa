/**
 * Unit tests for the client's awaitExec option assembly: the liveness probe
 * self-wires from the backend ops, explicit seam injections win, and the
 * transport is client-owned. Pure composition — no DBOS, no backend.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";

import type { AwaitExecOptions } from "./await-exec.js";
import { composeAwaitOptions, createSandboxClient, precreateStepTree, resolveCompletedSiblings } from "./create-sandbox.js";
import { createNoopLogger } from "../lib/console-logger.js";
import { STEP_SUBDIRS } from "./mount-plan.js";
import type { CreateSandboxMeta, SandboxLiveness } from "./types.js";

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
});

describe("resolveCompletedSiblings", () => {
    const meta: CreateSandboxMeta = {
        runId: "run-2",
        stepId: "de",
        analysisId: "an-1",
        childWorkflowId: "run-2-0",
        resources: { cpu: 1, memoryGb: 1 },
    };
    /** Stands in for the completed-step rows the query returns. */
    const poolOf = (rows: Array<{ run_id: string; step_id: string }>) =>
        ({
            query: async () => ({ rows }),
        }) as unknown as Pool;

    test("keeps this run's completed steps and drops other runs' and this step's own", async () => {
        const siblings = await resolveCompletedSiblings(
            poolOf([
                { run_id: "run-2", step_id: "qc" },
                { run_id: "run-2", step_id: "norm" },
                // A prior run's completed step: admissible for lineage, but not
                // a watch dir under this run's tree.
                { run_id: "run-1", step_id: "qc" },
                // The step's own prior attempt.
                { run_id: "run-2", step_id: "de" },
            ]),
            meta,
            createNoopLogger(),
        );

        expect(siblings).toEqual(["qc", "norm"]);
    });

    test("a failed lookup narrows the watch set instead of failing sandbox creation", async () => {
        const pool = {
            query: async () => {
                throw new Error("connection terminated");
            },
        } as unknown as Pool;

        expect(await resolveCompletedSiblings(pool, meta, createNoopLogger())).toEqual([]);
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
