import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUIDv7 } from "bun";
import { ok, okAsync, err } from "neverthrow";
import type { EmbeddingProvider } from "@inflexa-ai/harness";

import { env } from "../../lib/env.ts";
import { instanceLockPath } from "../../lib/lock.ts";
import { bootHarnessRuntime, __resetHarnessRuntimeForTest, type BootSeams } from "./runtime.ts";
import type { ResolvedHarnessConfig } from "./config.ts";
import type { ExecIngress } from "./ingress.ts";

let skillsDir: string;

function testConfig(overrides: Partial<ResolvedHarnessConfig> = {}): ResolvedHarnessConfig {
    skillsDir = join(tmpdir(), `harness-runtime-test-${randomUUIDv7()}`);
    mkdirSync(skillsDir, { recursive: true });
    return {
        model: "claude-test-model",
        bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
        sandboxImage: "sandbox-base:latest",
        resourceLimits: { maxCpu: 1, maxMemoryGb: 1, maxGpuCount: 0 },
        adminPort: 8433,
        skillsDir,
        ...overrides,
    };
}

/** A resolved-embedder stand-in with the api-key default width; never actually embeds in these offline tests. */
function fakeEmbedding(): EmbeddingProvider {
    return {
        dimensions: 1536,
        embed: (texts) => okAsync(texts.map(() => new Array(1536).fill(0))),
    };
}

function fakeIngress(calls: string[]): ExecIngress {
    return {
        port: 65_000,
        cortexBaseUrl: "http://host.docker.internal:65000",
        stop: () => {
            calls.push("ingress.stop");
        },
    };
}

// Seams that record their call order and succeed. The pool/providers built
// between them are pure construction (pg pools connect lazily), so the boot
// path runs fully offline.
function recordingSeams(calls: string[]): BootSeams {
    return {
        ensurePostgres: async () => {
            calls.push("postgres");
            return ok({ host: "localhost", port: 5, database: "d", user: "u", password: "p" });
        },
        startIngress: () => {
            calls.push("ingress");
            return ok(fakeIngress(calls));
        },
        readKey: async () => {
            calls.push("readKey");
            return ok("proxy-key");
        },
        resolveModel: async () => {
            calls.push("resolveModel");
            return ok("claude-from-proxy");
        },
        resolveEmbedding: () => {
            calls.push("resolveEmbedding");
            return ok(fakeEmbedding());
        },
        register: (deps) => {
            calls.push("register");
            // The one base every consumer must share (design D2).
            expect(deps.sessionsBasePath).toBe(env.sessionsDir);
            expect(deps.skillsDir).toBe(skillsDir);
            // The register deps carry the RESOLVED provider instance advertising
            // its width — the seam the per-analysis index is sized from.
            expect(deps.embedding.dimensions).toBe(1536);
            expect(deps.embedding.embed).toBeInstanceOf(Function);
            return async () => {};
        },
        registerSandboxStep: (deps) => {
            calls.push("registerSandboxStep");
            // The boot must wire the run-engine realizations onto the child deps:
            // the catalog-backed builder and a real embedding-provider instance.
            expect(deps.buildAgent).toBeInstanceOf(Function);
            expect(deps.artifactRegistry).toBeDefined();
            expect(deps.embedding).toBeDefined();
            return async () => ({ status: "complete", durationMs: 0, finishReason: null, error: null });
        },
        registerExecuteAnalysis: (deps) => {
            calls.push("registerExecuteAnalysis");
            // The parent's dispatch closes over the registered child callable, so
            // the child must already be registered by now (design D1).
            expect(deps.sandboxStepCallable).toBeInstanceOf(Function);
            return async () => ({ runId: "", workflowId: "", status: "completed", completedSteps: [], failedSteps: [], canceledSteps: [] });
        },
        registerReaper: () => {
            calls.push("registerReaper");
        },
        registerWatchdog: (deps) => {
            calls.push("registerWatchdog");
            // The watchdog reads the active-sandbox registry through a thunk over
            // the shared pool; a `ResultAsync` is returned, never awaited here.
            expect(deps.queryActiveSandboxes).toBeInstanceOf(Function);
        },
        registerNotificationSweep: () => {
            calls.push("registerNotificationSweep");
        },
        initState: async () => {
            calls.push("initState");
        },
        launch: async () => {
            calls.push("launch");
        },
        probeEmbedding: async () => {
            calls.push("probeEmbedding");
            return ok(undefined);
        },
    };
}

afterEach(() => {
    __resetHarnessRuntimeForTest();
    rmSync(skillsDir, { recursive: true, force: true });
});

describe("bootHarnessRuntime", () => {
    test("boots in the contract order: prereqs → postgres → ingress → schema init → registration cohort → launch", async () => {
        const calls: string[] = [];
        const result = await bootHarnessRuntime({ seams: recordingSeams(calls), config: testConfig() });

        const runtime = result._unsafeUnwrap();
        // The embedding provider resolves first (design: local-embeddings boots
        // ahead of the proxy key), then the whole registration cohort lands
        // between schema init and the single launch, child (sandbox-step) before
        // parent (execute-analysis), then the profile workflow, then the three
        // sandbox-hygiene crons (design D1/D5).
        expect(calls).toEqual([
            "resolveEmbedding",
            "readKey",
            "probeEmbedding",
            "postgres",
            "ingress",
            "initState",
            "registerSandboxStep",
            "registerExecuteAnalysis",
            "register",
            "registerReaper",
            "registerWatchdog",
            "registerNotificationSweep",
            "launch",
        ]);
        expect(runtime.model).toBe("claude-test-model");
        expect(runtime.triggerDeps.workflow).toBeInstanceOf(Function);
    });

    test("exposes run-trigger deps: the parent callable, a run launcher, and the run authorizer", async () => {
        const calls: string[] = [];
        const runtime = (await bootHarnessRuntime({ seams: recordingSeams(calls), config: testConfig() }))._unsafeUnwrap();

        expect(runtime.runTriggerDeps.executeAnalysis).toBeInstanceOf(Function);
        expect(runtime.runTriggerDeps.runLauncher.launch).toBeInstanceOf(Function);
        expect(runtime.runTriggerDeps.runAuthorizer.authorize).toBeInstanceOf(Function);
        // Same pool the ledger queries run against — mirrors triggerDeps.
        expect(runtime.runTriggerDeps.pool).toBe(runtime.pool);
    });

    test("registers the child sandbox-step before the execute-analysis parent, and every workflow before the single launch", async () => {
        const calls: string[] = [];
        await bootHarnessRuntime({ seams: recordingSeams(calls), config: testConfig() });

        const child = calls.indexOf("registerSandboxStep");
        const parent = calls.indexOf("registerExecuteAnalysis");
        const launch = calls.indexOf("launch");
        expect(child).toBeGreaterThanOrEqual(0);
        expect(child).toBeLessThan(parent);
        // Every registration precedes the one launch (recovery finds workflows by
        // registered name at launch; nothing may register after).
        const registrations = ["registerSandboxStep", "registerExecuteAnalysis", "register", "registerReaper", "registerWatchdog", "registerNotificationSweep"];
        for (const name of registrations) {
            expect(calls.indexOf(name)).toBeLessThan(launch);
        }
        expect(calls.filter((c) => c === "launch")).toHaveLength(1);
    });

    test("registers all three sandbox-hygiene scheduled workflows before launch", async () => {
        const calls: string[] = [];
        await bootHarnessRuntime({ seams: recordingSeams(calls), config: testConfig() });

        expect(calls).toContain("registerReaper");
        expect(calls).toContain("registerWatchdog");
        expect(calls).toContain("registerNotificationSweep");
        const launch = calls.indexOf("launch");
        for (const name of ["registerReaper", "registerWatchdog", "registerNotificationSweep"]) {
            expect(calls.indexOf(name)).toBeLessThan(launch);
        }
    });

    test("a failed prereq fires no workflow or scheduled registration", async () => {
        const calls: string[] = [];
        const seams: BootSeams = {
            ...recordingSeams(calls),
            ensurePostgres: async () => {
                calls.push("postgres");
                return err({ type: "ready_timeout", message: "pg_isready timed out" });
            },
        };
        const result = await bootHarnessRuntime({ seams, config: testConfig() });

        expect(result.isErr()).toBe(true);
        for (const name of [
            "registerSandboxStep",
            "registerExecuteAnalysis",
            "register",
            "registerReaper",
            "registerWatchdog",
            "registerNotificationSweep",
            "launch",
        ]) {
            expect(calls).not.toContain(name);
        }
    });

    test("resolves the model from the proxy only when config has none", async () => {
        const calls: string[] = [];
        const result = await bootHarnessRuntime({ seams: recordingSeams(calls), config: testConfig({ model: null }) });

        expect(result._unsafeUnwrap().model).toBe("claude-from-proxy");
        expect(calls).toContain("resolveModel");
    });

    test("second boot reuses the runtime without re-running any seam", async () => {
        const calls: string[] = [];
        const seams = recordingSeams(calls);
        const first = (await bootHarnessRuntime({ seams, config: testConfig() }))._unsafeUnwrap();
        const countAfterFirst = calls.length;

        const second = (await bootHarnessRuntime({ seams, config: testConfig() }))._unsafeUnwrap();
        expect(second).toBe(first);
        expect(calls).toHaveLength(countAfterFirst);
    });

    test("unavailable Postgres short-circuits before ingress/register/launch", async () => {
        const calls: string[] = [];
        const seams: BootSeams = {
            ...recordingSeams(calls),
            ensurePostgres: async () => {
                calls.push("postgres");
                return err({ type: "ready_timeout", message: "pg_isready timed out" });
            },
        };
        const result = await bootHarnessRuntime({ seams, config: testConfig() });

        expect(result._unsafeUnwrapErr()).toMatchObject({ type: "postgres_unavailable" });
        expect(calls).toEqual(["resolveEmbedding", "readKey", "probeEmbedding", "postgres"]);
    });

    test("an unresolved embedder fails before any side effect past resolution", async () => {
        const calls: string[] = [];
        const seams: BootSeams = {
            ...recordingSeams(calls),
            resolveEmbedding: () => {
                calls.push("resolveEmbedding");
                return err({ type: "embeddings_not_configured", message: "Embeddings are not configured." });
            },
        };
        const result = await bootHarnessRuntime({ seams, config: testConfig() });

        expect(result._unsafeUnwrapErr()).toMatchObject({ type: "embedding_unresolved", cause: { type: "embeddings_not_configured" } });
        expect(calls).toEqual(["resolveEmbedding"]);
    });

    test("a failing embedder probe blocks before postgres/ingress/launch", async () => {
        const calls: string[] = [];
        const seams: BootSeams = {
            ...recordingSeams(calls),
            probeEmbedding: async () => {
                calls.push("probeEmbedding");
                return err({ kind: "embed_failed", detail: "HTTP 404" });
            },
        };
        const result = await bootHarnessRuntime({ seams, config: testConfig() });

        expect(result._unsafeUnwrapErr()).toMatchObject({ type: "embedding_probe_failed", detail: "HTTP 404" });
        expect(calls).toEqual(["resolveEmbedding", "readKey", "probeEmbedding"]);
    });

    test("a wrong-dimension embedding model blocks before postgres/ingress/launch", async () => {
        const calls: string[] = [];
        const seams: BootSeams = {
            ...recordingSeams(calls),
            probeEmbedding: async () => {
                calls.push("probeEmbedding");
                return err({ kind: "dimension_mismatch", expected: 1536, actual: 768 });
            },
        };
        const result = await bootHarnessRuntime({ seams, config: testConfig() });

        expect(result._unsafeUnwrapErr()).toMatchObject({ type: "embedding_dimension_mismatch", expected: 1536, actual: 768 });
        expect(calls).toEqual(["resolveEmbedding", "readKey", "probeEmbedding"]);
    });

    test("an invalid harness config block fails before any side effect", async () => {
        const calls: string[] = [];
        const result = await bootHarnessRuntime({
            seams: recordingSeams(calls),
            config: testConfig({ configError: { issues: "harness.adminPort: expected number" } }),
        });

        expect(result._unsafeUnwrapErr()).toMatchObject({ type: "harness_config_invalid", issues: "harness.adminPort: expected number" });
        expect(calls).toEqual([]);
    });

    test("a non-Claude auto-resolved model is rejected at boot (Anthropic route)", async () => {
        const calls: string[] = [];
        const seams: BootSeams = {
            ...recordingSeams(calls),
            resolveModel: async () => {
                calls.push("resolveModel");
                return ok("gemini-2.5-pro");
            },
        };
        const result = await bootHarnessRuntime({ seams, config: testConfig({ model: null }) });

        expect(result._unsafeUnwrapErr()).toMatchObject({ type: "model_not_claude", model: "gemini-2.5-pro" });
        expect(calls).not.toContain("postgres");
    });

    test("an explicitly-configured non-Claude model is trusted (no family guard)", async () => {
        const calls: string[] = [];
        const result = await bootHarnessRuntime({ seams: recordingSeams(calls), config: testConfig({ model: "gpt-4o" }) });

        expect(result._unsafeUnwrap().model).toBe("gpt-4o");
        expect(calls).toContain("launch");
    });

    test("missing skills dir fails before any side effect", async () => {
        const calls: string[] = [];
        const cfg = testConfig();
        rmSync(skillsDir, { recursive: true, force: true });
        const result = await bootHarnessRuntime({ seams: recordingSeams(calls), config: cfg });

        expect(result._unsafeUnwrapErr()).toMatchObject({ type: "skills_dir_missing" });
        expect(calls).toEqual([]);
    });

    test("a throwing launch releases the ingress and reports runtime_boot_failed", async () => {
        const calls: string[] = [];
        const seams: BootSeams = {
            ...recordingSeams(calls),
            launch: async () => {
                calls.push("launch");
                throw new Error("dbos exploded");
            },
        };
        const result = await bootHarnessRuntime({ seams, config: testConfig() });

        expect(result._unsafeUnwrapErr()).toMatchObject({ type: "runtime_boot_failed" });
        expect(calls).toContain("ingress.stop");
    });

    test("a runtime lock held by a live foreign process blocks the boot and releases the ingress", async () => {
        const calls: string[] = [];
        // Fake another live inflexa process holding the machine-wide runtime lock.
        const holder = Bun.spawn(["sleep", "60"]);
        const lockPath = instanceLockPath("harness-runtime");
        mkdirSync(dirname(lockPath), { recursive: true });
        writeFileSync(lockPath, String(holder.pid));
        try {
            const result = await bootHarnessRuntime({ seams: recordingSeams(calls), config: testConfig() });
            expect(result._unsafeUnwrapErr()).toMatchObject({ type: "runtime_already_active", holderPid: holder.pid });
            // The ingress bound just before the lock check must be torn down.
            expect(calls).toContain("ingress.stop");
            expect(calls).not.toContain("launch");
        } finally {
            rmSync(lockPath, { force: true });
            holder.kill();
            await holder.exited;
        }
    });
});
