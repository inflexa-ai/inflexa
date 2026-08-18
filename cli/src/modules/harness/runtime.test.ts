import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUIDv7 } from "bun";
import { ok, okAsync, err } from "neverthrow";
import {
    createCitationResolver,
    createSandboxClient,
    type CoreRuntimeDeps,
    type CreateSandboxClientConfig,
    type EmbeddingProvider,
    type FarmResolution,
    type LlmUsageRecord,
} from "@inflexa-ai/harness";

import { ContainerRuntimeError, runtimes } from "../../lib/container.ts";
import { env } from "../../lib/env.ts";
import { type Credential, type CredentialError, type CredentialScheme, type CredentialSource } from "../../lib/credential.ts";
import { instanceLockPath } from "../../lib/lock.ts";
import { extendFarm, makeEmptyFarm } from "../libs/composition.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";
import { bootHarnessRuntime, buildAuthInjectingFetch, linkPackagesIntoFarm, __resetHarnessRuntimeForTest, type BootSeams } from "./runtime.ts";
import { agentProviderInner } from "./agent_switch.ts";
import type { ResolvedHarnessConfig, ResolvedModelConnection } from "./config.ts";
import type { ExecIngress } from "./ingress.ts";

/** A direct connection to a stubbed OpenAI-compatible endpoint — used by the direct-mode boot tests. */
function directConnection(overrides: Partial<Extract<ResolvedModelConnection, { mode: "direct" }>> = {}): ResolvedModelConnection {
    return { mode: "direct", provider: "deepseek", baseURL: "https://api.deepseek.com/v1", protocol: "openai-compatible", agents: {}, ...overrides };
}

/** A cliproxy connection with the given provider and optional agent overrides — for the boot resolution tests. */
function cliproxyConnection(provider: string, agents: ResolvedModelConnection["agents"] = {}): ResolvedModelConnection {
    return { mode: "cliproxy", provider, agents };
}

/** The host path the offline `resolveImagePackages` seam returns — the extracted image fragment cache. */
const IMAGE_FRAGMENT_PATH = "/cache/inflexa/libs/sha256-test.txt";

let skillsDir: string;
let templatesDir: string;

/**
 * The `core` bundle the last boot handed to the harness — i.e. exactly what `assembleCoreRuntime`
 * receives. Captured rather than asserted inline so the seam-wiring tests can interrogate it after the
 * fact instead of piling more expectations into the `boot` stub.
 */
let lastCore: CoreRuntimeDeps | null = null;

function testConfig(overrides: Partial<ResolvedHarnessConfig> = {}): ResolvedHarnessConfig {
    skillsDir = join(tmpdir(), `harness-runtime-test-skills-${randomUUIDv7()}`);
    templatesDir = join(tmpdir(), `harness-runtime-test-templates-${randomUUIDv7()}`);
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(templatesDir, { recursive: true });
    return {
        model: "claude-test-model",
        bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
        sandboxImage: "ghcr.io/inflexa-ai/sandbox-base:latest",
        resourcePolicy: { perStep: { maxCpu: 1, maxMemoryGb: 1, maxGpuCount: 0 }, budget: { cpu: 1, memoryGb: 1 } },
        adminPort: 8433,
        skillsDir,
        templatesDir,
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

/**
 * Seed the ONE host package store root at `env.libStoreDir` and return it. The root is a CLI-owned path
 * with no config key, so a test cannot point the store somewhere else — it seeds the real location, which
 * the bunfig preload has already redirected into the test sandbox (`assertTestSandbox` proves that here
 * before any write). The store carries no active farm: its inventory is the POOL, which the dependency
 * graph names. `withInventory` seeds that graph, so a root without it is a store no sandbox could mount.
 */
function seedLibStoreRoot(withInventory: boolean): string {
    const root = env.libStoreDir;
    assertTestSandbox(root);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    if (withInventory) {
        // The graph is what the real `storePackagesFile` derives the pool inventory from. The boot tests
        // stub that seam, so this only has to be a store that a reader would call usable.
        writeFileSync(
            join(root, "deps.json"),
            JSON.stringify({
                version: 1,
                nodes: { "numpy-1.26.4-0000000000000000": { track: "python", imports: ["numpy"], entry_points: [], edges: [] } },
                by_name: { python: { numpy: ["numpy-1.26.4-0000000000000000"] }, r: {} },
            }),
        );
    }
    return root;
}

/**
 * A store root the composer can work from: the fixture pool of the composition tests, its graph, and a
 * catalog template farm.
 *
 * The template is DERIVED rather than checked in, exactly as `composition.test.ts` derives it: a tree of
 * links whose targets resolve nowhere on the host would be checked-in debris. Its lock names the default
 * roots of a new analysis farm.
 */
function seedComposableStore(withTemplate: boolean): string {
    const root = env.libStoreDir;
    assertTestSandbox(root);
    assertTestSandbox(env.locksDir);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    cpSync(join(import.meta.dir, "..", "libs", "test-fixtures", "farm-parity"), root, { recursive: true });
    if (!withTemplate) return root;
    const template = join(root, "farms", "catalog");
    mkdirSync(join(template, "python", "site-packages"), { recursive: true });
    writeFileSync(
        join(template, "lock.json"),
        JSON.stringify({ requested: ["beta"], resolved: ["beta==0.4.1"], store_dirs: ["alpha-1.2.0-000000000000aaaa", "beta-0.4.1-000000000000bbbb"] }),
    );
    writeFileSync(join(template, "meta.json"), JSON.stringify({ version: "catalog", arch: "linux-arm64", tracks: ["python"] }));
    return root;
}

/** Drop the seeded store root, so one test's store never decides the next test's inventory. */
function clearLibStoreRoot(): void {
    assertTestSandbox(env.libStoreDir);
    rmSync(env.libStoreDir, { recursive: true, force: true });
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
        // Offline stub: the real seam reads the active farm's inventory off disk. A path is the
        // ordinary answer, because a boot with no readable inventory refuses — a test that wants that
        // refusal overrides this seam with `() => null`.
        resolveStorePackages: (root: string) => {
            calls.push("resolveStorePackages");
            return join(root, "packages.txt");
        },
        // Offline stub: the real seam runs a container to extract the image fragment and caches it. A path
        // is the ordinary answer; a test that wants the degraded case overrides this with `() => null`.
        resolveImagePackages: async () => {
            calls.push("resolveImagePackages");
            return IMAGE_FRAGMENT_PATH;
        },
        resolveSandboxEngine: async () => {
            calls.push("resolveSandboxEngine");
            // Default to a docker pin (today's behavior): no socket, no step-tree loosening.
            return ok({ runtime: runtimes.docker, socketPath: undefined });
        },
        ensurePostgres: async () => {
            calls.push("postgres");
            return ok({ host: "localhost", port: 5, database: "d", user: "u", password: "p" });
        },
        // Real construction (pure, connects lazily) so the offline boot runs unchanged;
        // the engine-wiring tests below swap this for a capturing variant.
        createSandbox: createSandboxClient,
        startIngress: () => {
            calls.push("ingress");
            return ok(fakeIngress(calls));
        },
        readKey: async () => {
            calls.push("readKey");
            return ok("proxy-key");
        },
        readModelApiKey: () => {
            calls.push("readModelApiKey");
            return "direct-model-key";
        },
        resolveModel: async () => {
            calls.push("resolveModel");
            return ok("claude-from-proxy");
        },
        resolveEmbedding: () => {
            calls.push("resolveEmbedding");
            return ok(fakeEmbedding());
        },
        boot: async (deps) => {
            calls.push("boot");
            lastCore = deps.core;
            // The shape assertions that used to live in the `assemble` seam now
            // inspect `deps.core`: the real `bootHarness` calls `assembleCoreRuntime`
            // over it internally (child-before-parent registration is the harness's
            // invariant, proven by the harness's own boot test). So this offline seam
            // asserts the deps arrived shaped correctly, runs the embedder's
            // pre-launch hook, and returns the registered callables + a no-op shutdown.
            const { workflows, conversation } = deps.core;
            // The sandbox-step child carries the catalog-backed builder and the
            // bus-adapter artifact registry (its `register`/`sync` translate a step's
            // artifacts into `prov.*` events).
            expect(workflows.sandboxStep.buildAgent).toBeInstanceOf(Function);
            expect(workflows.sandboxStep.artifactRegistry.register).toBeInstanceOf(Function);
            expect(workflows.sandboxStep.artifactRegistry.sync).toBeInstanceOf(Function);
            // The parent builder receives the registered child callable and wires the
            // bridge's run-lifecycle emitter as the optional provenance observer
            //. Exercise it with a stand-in child callable.
            const child = async () => ({ status: "complete" as const, durationMs: 0, finishReason: null, error: null });
            const executeAnalysisDeps = workflows.buildExecuteAnalysis(child);
            expect(executeAnalysisDeps.sandboxStepCallable).toBe(child);
            expect(executeAnalysisDeps.emitProvenance).toBeInstanceOf(Function);
            // The data-profile bundle carries the workspace-root seam every consumer
            // shares plus the RESOLVED provider instance advertising its
            // index width. The ONE resolver instance built at boot threads to every
            // bundle, so identity (not just shape) is the invariant.
            expect(workflows.dataProfile.resolveWorkspaceRoot).toBeInstanceOf(Function);
            expect(workflows.dataProfile.resolveWorkspaceRoot).toBe(workflows.sandboxStep.resolveWorkspaceRoot);
            expect(workflows.dataProfile.resolveWorkspaceRoot).toBe(conversation.resolveWorkspaceRoot);
            expect(workflows.dataProfile.skillsDir).toBe(skillsDir);
            expect(workflows.dataProfile.embedding.dimensions).toBe(1536);
            expect(workflows.dataProfile.embedding.embed).toBeInstanceOf(Function);
            // The target-assessment bundle carries the shared sandbox backend.
            expect(workflows.executeTargetAssessment.chatProvider).toBeDefined();
            expect(conversation.utilityProvider).toBeDefined();
            expect(conversation.utilityModel).toBeDefined();
            // The conversation bundle carries the local realizations: the configured
            // templates tree, the read-only report-html skills tree, the
            // unavailable-preview factory, and the shared launcher.
            expect(conversation.templatesDir).toBe(templatesDir);
            expect(conversation.skillsDir).toBe(skillsDir);
            expect(conversation.createPreviewPublisher).toBeInstanceOf(Function);
            expect(conversation.runLauncher.launch).toBeInstanceOf(Function);
            // The Logger seam reaches every conversation tool that takes one — `generate_plan`
            // above all, which drives a whole sub-agent loop and writes no ledger row, so its
            // records are the only account of an invocation. `ConversationAgentDeps.logger` is
            // OPTIONAL and falls back to `createNoopLogger()`, so omitting this field is not a
            // type error and not a runtime error: it silently discards every diagnostic. That
            // is how a planner failing for nine minutes produced an empty log, and this
            // assertion is what makes the omission fail loudly instead.
            expect(conversation.logger).toBeDefined();
            expect(conversation.logger?.named).toBeInstanceOf(Function);
            // The embedder hands the harness its skills root and its own no-op
            // telemetry (the CLI owns OTel); the boot handle owns skills validation,
            // state init, the connection budget, assemble, and launch itself.
            expect(deps.skillsDir).toBe(skillsDir);
            expect(deps.initTelemetry).toBeInstanceOf(Function);
            // Run the embedder's pre-launch hook so its sweep → agent-switch install →
            // crons execute in order, exactly as the real `bootHarness` runs it after
            // registration and before launch.
            await deps.beforeLaunch?.();
            return {
                runtime: {
                    agents: { forThread: () => ok({ id: "conversation-agent", systemPrompt: "", model: "claude-test-model", tools: [], maxIterations: 50 }) },
                    workflows: {
                        executeAnalysis: async () => ({
                            runId: "",
                            workflowId: "",
                            status: "completed",
                            completedSteps: [],
                            failedSteps: [],
                            canceledSteps: [],
                        }),
                        sandboxStep: async () => ({ status: "complete", durationMs: 0, finishReason: null, error: null }),
                        executeTargetAssessment: async () => ({ assessmentId: "", status: "completed", bytes: 0 }),
                        dataProfile: async () => {},
                    },
                    // `CoreRuntime` requires the resolver `assembleCoreRuntime` builds; the
                    // real (pure, network-lazy) constructor stands in here, matching how this
                    // seam uses the real `createSandboxClient` above.
                    citationResolver: createCitationResolver(),
                },
                shutdown: async () => {},
            };
        },
        sweepEphemeral: async () => {
            calls.push("sweepEphemeral");
        },
        // The ask-expiry sweep is a seam for the same reason `sweepEphemeral` is:
        // it lets `beforeLaunch` run offline with no live ask ledger to query.
        sweepAsks: async () => {
            calls.push("sweepAsks");
            return 0;
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
        probeEmbedding: async () => {
            calls.push("probeEmbedding");
            return ok(undefined);
        },
    };
}

// A successful boot's `acquireInstanceLock(RUNTIME_LOCK_KEY)` does a real `mkdirSync`/`writeFileSync`
// under `env.locksDir`. env.ts's import-time backstop only fires under NODE_ENV=test — a shell that
// pre-exported NODE_ENV (e.g. `NODE_ENV=development bun test`) disables it, and bun does not force it —
// so this per-file guard is the belt-and-suspenders that keeps the boot tests off the developer's REAL
// ~/.local/share/inflexa/locks. It throws unless the bunfig preload stamped INFLEXA_TEST_SANDBOX and the
// path lives inside it (see test_support/sandbox.ts).
beforeEach(() => {
    assertTestSandbox(env.locksDir);
});

afterEach(() => {
    __resetHarnessRuntimeForTest();
    lastCore = null;
    rmSync(skillsDir, { recursive: true, force: true });
    rmSync(templatesDir, { recursive: true, force: true });
});

describe("bootHarnessRuntime", () => {
    test("boots in the contract order: prereqs → postgres → bootHarness (which runs the embedder's beforeLaunch: sweep → crons)", async () => {
        const calls: string[] = [];
        const result = await bootHarnessRuntime({ seams: recordingSeams(calls), config: testConfig() });

        const runtime = result._unsafeUnwrap();
        // The embedding provider resolves first (local-embeddings boots ahead of the
        // proxy key). This root then resolves Postgres and hands the harness's
        // `bootHarness` the deps; the harness owns skills validation, state init, the
        // connection budget, assemble, and launch (each proven by the harness's own
        // boot test, not re-asserted here). The embedder's `beforeLaunch` hook — which
        // `bootHarness` runs after registration and before launch — cancels stale
        // legacy ephemeral rows, installs the agent switch, then registers the three
        // sandbox-hygiene crons. The CLI is a poll-mode embedder, so it binds NO
        // callback ingress — `startIngress` is never called.
        expect(calls).toEqual([
            "resolveEmbedding",
            "readKey",
            "probeEmbedding",
            "resolveSandboxEngine",
            "postgres",
            // The store inventory read sits AFTER the prereq gates: a boot about to fail on
            // Postgres never pays for it. The image fragment extraction follows it.
            "resolveStorePackages",
            "resolveImagePackages",
            "boot",
            "sweepEphemeral",
            "sweepAsks",
            "registerReaper",
            "registerWatchdog",
            "registerNotificationSweep",
        ]);
        expect(calls).not.toContain("ingress");
        // No `models.agents` and a single `harness.model` (claude-test-model): all roles resolve to it
        // and share ONE underlying provider instance. Each role carries its own swappable HANDLE
        // (so a later live switch of one agent re-points only that agent), but the
        // handles delegate to the SAME inner, which is the referential invariant that matters.
        expect(runtime.conversation.model).toBe("claude-test-model");
        expect(runtime.sandbox.model).toBe("claude-test-model");
        expect(runtime.utility.model).toBe("claude-test-model");
        expect(agentProviderInner(runtime.sandbox.provider)).toBe(agentProviderInner(runtime.conversation.provider));
        expect(agentProviderInner(runtime.utility.provider)).toBe(agentProviderInner(runtime.conversation.provider));
        expect(runtime.triggerDeps.workflow).toBeInstanceOf(Function);
        // The assembled conversation agent + its agent provider are on the handle (the `chat` command
        // drives `runAgent(conversationAgent, …, conversation.provider)`). The agent is reached by thread
        // type through the resolver — `conversation` resolves to the assembled conversation agent.
        expect(runtime.agents.forThread("conversation")._unsafeUnwrap().id).toBe("conversation-agent");
        expect(runtime.conversation.provider).toBeDefined();
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

    test("delegates the boot tail to bootHarness once, and its beforeLaunch hook runs the legacy sweep before registering crons", async () => {
        const calls: string[] = [];
        await bootHarnessRuntime({ seams: recordingSeams(calls), config: testConfig() });

        const boot = calls.indexOf("boot");
        const sweep = calls.indexOf("sweepEphemeral");
        // The harness owns the whole boot tail (state init → connection budget →
        // assemble → beforeLaunch → launch), so this root calls `boot` exactly once
        // and never re-drives those steps itself. Schema init / assemble / launch are
        // the harness's job — proven by the harness's own boot test, not observable
        // in this offline seam.
        expect(boot).toBeGreaterThanOrEqual(0);
        expect(calls.filter((c) => c === "boot")).toHaveLength(1);
        // The embedder's `beforeLaunch` hook (which `bootHarness` runs after
        // registration and before launch) sweeps legacy stale rows FIRST, then
        // registers the three sandbox-hygiene crons — all after `boot` is entered.
        expect(boot).toBeLessThan(sweep);
        for (const name of ["registerReaper", "registerWatchdog", "registerNotificationSweep"]) {
            expect(sweep).toBeLessThan(calls.indexOf(name));
        }
    });

    test("its beforeLaunch hook registers all three sandbox-hygiene scheduled workflows", async () => {
        const calls: string[] = [];
        await bootHarnessRuntime({ seams: recordingSeams(calls), config: testConfig() });

        expect(calls).toContain("registerReaper");
        expect(calls).toContain("registerWatchdog");
        expect(calls).toContain("registerNotificationSweep");
        // The crons register inside `beforeLaunch`, which `bootHarness` runs before
        // it launches DBOS — so each records after `boot` is entered.
        const boot = calls.indexOf("boot");
        for (const name of ["registerReaper", "registerWatchdog", "registerNotificationSweep"]) {
            expect(calls.indexOf(name)).toBeGreaterThan(boot);
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
        // A failed prereq short-circuits before the harness boot is even entered, so
        // neither `bootHarness` nor anything its `beforeLaunch` hook drives runs.
        for (const name of ["boot", "sweepEphemeral", "registerReaper", "registerWatchdog", "registerNotificationSweep"]) {
            expect(calls).not.toContain(name);
        }
    });

    test("resolves the model from the proxy only when config has none — all roles share the ONE auto-resolve", async () => {
        const calls: string[] = [];
        const runtime = (await bootHarnessRuntime({ seams: recordingSeams(calls), config: testConfig({ model: null }) }))._unsafeUnwrap();

        // All roles fall through to the proxy default; the auto-resolve is memoized, so `/models` is hit
        // ONCE and all swappable handles delegate to the resulting id's single provider instance.
        expect(runtime.conversation.model).toBe("claude-from-proxy");
        expect(runtime.sandbox.model).toBe("claude-from-proxy");
        expect(runtime.utility.model).toBe("claude-from-proxy");
        expect(agentProviderInner(runtime.sandbox.provider)).toBe(agentProviderInner(runtime.conversation.provider));
        expect(agentProviderInner(runtime.utility.provider)).toBe(agentProviderInner(runtime.conversation.provider));
        expect(calls.filter((c) => c === "resolveModel")).toHaveLength(1);
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

    test("two concurrent boots share one in-flight attempt: seams run once, both callers get the same runtime", async () => {
        const calls: string[] = [];
        const seams = recordingSeams(calls);
        const cfg = testConfig();
        // Both calls are issued BEFORE the first settles. The second must ride the first's memoized
        // in-flight promise rather than start a second registration cohort — which would throw in DBOS
        // re-registration and release the shared runtime lock out from under the first boot's live engine.
        const [r1, r2] = await Promise.all([bootHarnessRuntime({ seams, config: cfg }), bootHarnessRuntime({ seams, config: cfg })]);

        const runtime = r1._unsafeUnwrap();
        expect(r2._unsafeUnwrap()).toBe(runtime); // one runtime, shared by both callers
        // The whole sequence ran exactly once — `boot` (the harness boot tail: assemble
        // + launch) appears a single time, so no second boot registered anything.
        expect(calls.filter((c) => c === "boot")).toHaveLength(1);
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
        expect(calls).toEqual(["resolveEmbedding", "readKey", "probeEmbedding", "resolveSandboxEngine", "postgres"]);
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

    test("an auto-resolved model whose family mismatches the configured provider is rejected at boot", async () => {
        const calls: string[] = [];
        const seams: BootSeams = {
            ...recordingSeams(calls),
            resolveModel: async () => {
                calls.push("resolveModel");
                return ok("gemini-2.5-pro");
            },
        };
        // The default connection is cliproxy/anthropic, so this degenerates to exactly the old
        // Claude-only check: a gemini id does not match the anthropic family.
        const result = await bootHarnessRuntime({
            seams,
            config: testConfig({ model: null }),
            connection: cliproxyConnection("anthropic"),
        });

        expect(result._unsafeUnwrapErr()).toMatchObject({ type: "model_provider_mismatch", provider: "anthropic", model: "gemini-2.5-pro" });
        expect(calls).not.toContain("postgres");
    });

    test("an auto-resolved model whose family matches the configured provider boots (non-anthropic cliproxy account)", async () => {
        const calls: string[] = [];
        const seams: BootSeams = {
            ...recordingSeams(calls),
            resolveModel: async () => {
                calls.push("resolveModel");
                return ok("gpt-4o");
            },
        };
        const result = await bootHarnessRuntime({
            seams,
            config: testConfig({ model: null }),
            connection: cliproxyConnection("openai"),
        });

        expect(result._unsafeUnwrap().sandbox.model).toBe("gpt-4o");
        expect(calls).toContain("boot");
    });

    test("an explicitly-configured off-family model is trusted (the guard only checks the auto path)", async () => {
        const calls: string[] = [];
        const result = await bootHarnessRuntime({
            seams: recordingSeams(calls),
            config: testConfig({ model: "gpt-4o" }),
            connection: cliproxyConnection("anthropic"),
        });

        expect(result._unsafeUnwrap().sandbox.model).toBe("gpt-4o");
        expect(calls).toContain("boot");
    });

    test("a malformed models.connection block fails boot before any side effect", async () => {
        const calls: string[] = [];
        const result = await bootHarnessRuntime({
            seams: recordingSeams(calls),
            config: testConfig(),
            connection: { mode: "cliproxy", provider: "anthropic", agents: {}, configError: { issues: "models.connection.baseURL: Required" } },
        });

        expect(result._unsafeUnwrapErr()).toMatchObject({ type: "model_connection_invalid", issues: "models.connection.baseURL: Required" });
        expect(calls).toEqual([]);
    });

    test("direct mode boots with the explicit model, reads the env key, and never contacts the proxy", async () => {
        const calls: string[] = [];
        const result = await bootHarnessRuntime({
            seams: recordingSeams(calls),
            config: testConfig({ model: "some-alias-v2" }),
            connection: directConnection(),
        });

        const runtime = result._unsafeUnwrap();
        expect(runtime.conversation.model).toBe("some-alias-v2");
        expect(runtime.sandbox.model).toBe("some-alias-v2");
        // The direct path reads the env secret, never the proxy client key, and never the proxy /models.
        expect(calls).toContain("readModelApiKey");
        expect(calls).not.toContain("readKey");
        expect(calls).not.toContain("resolveModel");
        expect(calls).toContain("boot");
    });

    test("direct mode with no configured model fails boot with model_required naming every role (no proxy auto-resolve)", async () => {
        const calls: string[] = [];
        const result = await bootHarnessRuntime({
            seams: recordingSeams(calls),
            config: testConfig({ model: null }),
            connection: directConnection(),
        });

        // No role has an override or harness.model fallback, so one actionable error names all three.
        expect(result._unsafeUnwrapErr()).toMatchObject({ type: "model_required", agents: ["conversation", "sandbox", "utility"] });
        expect(calls).not.toContain("resolveModel");
        expect(calls).not.toContain("postgres");
    });

    test("direct mode with a per-role override for only one role names both unresolved roles", async () => {
        const calls: string[] = [];
        const result = await bootHarnessRuntime({
            seams: recordingSeams(calls),
            config: testConfig({ model: null }),
            connection: directConnection({ agents: { conversation: "deepseek-chat" } }),
        });

        // conversation resolves from its override; sandbox and utility have no fallback.
        expect(result._unsafeUnwrapErr()).toMatchObject({ type: "model_required", agents: ["sandbox", "utility"] });
        expect(calls).not.toContain("postgres");
    });

    test("direct mode with all roles overridden boots on distinct models with one inner per model", async () => {
        const calls: string[] = [];
        const result = await bootHarnessRuntime({
            seams: recordingSeams(calls),
            config: testConfig({ model: null }),
            connection: directConnection({
                agents: { conversation: "deepseek-chat", sandbox: "deepseek-reasoner", utility: "deepseek-utility" },
            }),
        });

        const runtime = result._unsafeUnwrap();
        expect(runtime.conversation.model).toBe("deepseek-chat");
        expect(runtime.sandbox.model).toBe("deepseek-reasoner");
        expect(runtime.utility.model).toBe("deepseek-utility");
        // Distinct resolved models ⇒ distinct inners over the one connection.
        expect(agentProviderInner(runtime.sandbox.provider)).not.toBe(agentProviderInner(runtime.conversation.provider));
        expect(agentProviderInner(runtime.utility.provider)).not.toBe(agentProviderInner(runtime.conversation.provider));
        expect(agentProviderInner(runtime.utility.provider)).not.toBe(agentProviderInner(runtime.sandbox.provider));
        expect(calls).toContain("boot");
    });

    test("per-role resolution order: one override wins while the other two share the harness.model inner", async () => {
        const calls: string[] = [];
        // harness.model = claude-test-model is the fallback; only sandbox overrides it. conversation
        // therefore rides the fallback and sandbox rides its own override — the resolution order applied per agent.
        const result = await bootHarnessRuntime({
            seams: recordingSeams(calls),
            config: testConfig({ model: "claude-test-model" }),
            connection: cliproxyConnection("anthropic", { sandbox: "claude-sonnet-4-5" }),
        });

        const runtime = result._unsafeUnwrap();
        expect(runtime.conversation.model).toBe("claude-test-model");
        expect(runtime.sandbox.model).toBe("claude-sonnet-4-5");
        expect(runtime.utility.model).toBe("claude-test-model");
        expect(agentProviderInner(runtime.sandbox.provider)).not.toBe(agentProviderInner(runtime.conversation.provider));
        expect(agentProviderInner(runtime.utility.provider)).toBe(agentProviderInner(runtime.conversation.provider));
        // An agent override is trusted like harness.model — the proxy /models is never consulted.
        expect(calls).not.toContain("resolveModel");
    });

    test("an agent override in cliproxy mode is trusted off-family — the guard only checks the auto-resolved default", async () => {
        const calls: string[] = [];
        // Provider anthropic, but the sandbox agent names a gpt id explicitly; conversation falls to the
        // auto-default (claude-from-proxy, family-guarded). The explicit sandbox override is NOT guarded.
        const result = await bootHarnessRuntime({
            seams: recordingSeams(calls),
            config: testConfig({ model: null }),
            connection: cliproxyConnection("anthropic", { sandbox: "gpt-4o" }),
        });

        const runtime = result._unsafeUnwrap();
        expect(runtime.conversation.model).toBe("claude-from-proxy");
        expect(runtime.sandbox.model).toBe("gpt-4o");
        expect(calls).toContain("boot");
    });

    test("direct mode with no resolvable key fails boot naming the provider-conventional variable", async () => {
        const calls: string[] = [];
        const seams: BootSeams = {
            ...recordingSeams(calls),
            readModelApiKey: () => {
                calls.push("readModelApiKey");
                return undefined;
            },
        };
        // The default direct connection is provider `deepseek` (openai-compatible), so the tried fallback
        // is OPENAI_API_KEY; the error carries it so the message can name both it and INFLEXA_MODEL_API_KEY.
        const result = await bootHarnessRuntime({ seams, config: testConfig({ model: "some-alias-v2" }), connection: directConnection() });

        expect(result._unsafeUnwrapErr()).toEqual({ type: "model_api_key_missing", providerVar: "OPENAI_API_KEY" });
        expect(calls).not.toContain("readKey");
        expect(calls).not.toContain("postgres");
    });

    test("direct mode with an anthropic provider names ANTHROPIC_API_KEY as the tried fallback", async () => {
        const calls: string[] = [];
        const seams: BootSeams = {
            ...recordingSeams(calls),
            readModelApiKey: () => undefined,
        };
        const connection = directConnection({ provider: "anthropic", baseURL: "https://api.anthropic.com/v1", protocol: "anthropic" });
        const result = await bootHarnessRuntime({ seams, config: testConfig({ model: "some-alias-v2" }), connection });

        expect(result._unsafeUnwrapErr()).toEqual({ type: "model_api_key_missing", providerVar: "ANTHROPIC_API_KEY" });
    });

    test("a configured auth source overrides the env key — readModelApiKey is never consulted", async () => {
        const calls: string[] = [];
        // recordingSeams' readModelApiKey returns a key and records the call; the auth block must short-circuit
        // it so the env key is never consulted (spec: a configured source overrides INFLEXA_MODEL_API_KEY).
        const result = await bootHarnessRuntime({
            seams: recordingSeams(calls),
            config: testConfig({ model: "some-model" }),
            connection: directConnection({ auth: { kind: "env", var: "SOME_BEARER_TOKEN", scheme: "bearer" } }),
        });

        result._unsafeUnwrap();
        expect(calls).not.toContain("readModelApiKey");
        // The command/env is resolved lazily at the wire, not at boot, so boot proceeds without a token in hand.
        expect(calls).toContain("boot");
    });

    test("missing skills dir fails before any side effect", async () => {
        const calls: string[] = [];
        const cfg = testConfig();
        rmSync(skillsDir, { recursive: true, force: true });
        const result = await bootHarnessRuntime({ seams: recordingSeams(calls), config: cfg });

        expect(result._unsafeUnwrapErr()).toMatchObject({ type: "skills_dir_missing" });
        expect(calls).toEqual([]);
    });

    test("missing templates dir fails before any side effect", async () => {
        const calls: string[] = [];
        const cfg = testConfig();
        // Skills tree stays present, so the templates gate (which sits right after it)
        // is the one that fires — a distinct pre-flight prerequisite.
        rmSync(templatesDir, { recursive: true, force: true });
        const result = await bootHarnessRuntime({ seams: recordingSeams(calls), config: cfg });

        expect(result._unsafeUnwrapErr()).toMatchObject({ type: "templates_dir_missing" });
        expect(calls).toEqual([]);
    });

    test("a throwing bootHarness is bridged to runtime_boot_failed", async () => {
        const calls: string[] = [];
        const seams: BootSeams = {
            ...recordingSeams(calls),
            boot: async () => {
                calls.push("boot");
                throw new Error("dbos exploded");
            },
        };
        const result = await bootHarnessRuntime({ seams, config: testConfig() });

        // `bootHarness` propagates its boot-step failures as throws (validate skills,
        // state init, launch), which this root bridges to a Result. Poll mode bound no
        // ingress, so the failure path has nothing to tear down but the
        // (in-process-reclaimable) runtime lock.
        expect(result._unsafeUnwrapErr()).toMatchObject({ type: "runtime_boot_failed" });
        expect(calls).toContain("boot");
    });

    test("a runtime lock held by a live foreign process blocks the boot before launch, having bound no ingress", async () => {
        const calls: string[] = [];
        const lockPath = instanceLockPath("harness-runtime");
        // lockPath is under env.locksDir — the developer's REAL ~/.local/share/inflexa/locks at the
        // monorepo root. Refuse to write/rm it there (data-loss guard — sandbox.ts), before we even
        // spawn the fake holder, so a root run leaves nothing behind.
        assertTestSandbox(lockPath);
        // Fake another live inflexa process holding the machine-wide runtime lock.
        const holder = Bun.spawn(["sleep", "60"]);
        mkdirSync(dirname(lockPath), { recursive: true });
        writeFileSync(lockPath, String(holder.pid));
        try {
            const result = await bootHarnessRuntime({ seams: recordingSeams(calls), config: testConfig() });
            expect(result._unsafeUnwrapErr()).toMatchObject({ type: "runtime_already_active", holderPid: holder.pid });
            // Poll mode never bound an ingress, so there is nothing to leak, and the
            // boot must stop before launching DBOS.
            expect(calls).not.toContain("ingress");
            expect(calls).not.toContain("boot");
        } finally {
            rmSync(lockPath, { force: true });
            holder.kill();
            await holder.exited;
        }
    });

    test("a podman pin threads the resolved socket and host-preserved bind ownership into the sandbox client", async () => {
        const calls: string[] = [];
        // Captured on an object property: a bare `let` assigned only inside the seam
        // closure gets narrowed back to `null` by control-flow analysis across the await.
        const captured: { config: CreateSandboxClientConfig | null } = { config: null };
        const seams: BootSeams = {
            ...recordingSeams(calls),
            resolveSandboxEngine: async () => {
                calls.push("resolveSandboxEngine");
                return ok({ runtime: runtimes.podman, socketPath: "/var/folders/xy/podman-api.sock" });
            },
            createSandbox: (cfg) => {
                captured.config = cfg;
                return createSandboxClient(cfg);
            },
        };
        const result = await bootHarnessRuntime({ seams, config: testConfig() });

        expect(result.isOk()).toBe(true);
        // A podman pin dials the resolved compat socket and declares the engine's
        // honest bind ownership so the harness makes the step tree workload-writable.
        expect(captured.config).not.toBeNull();
        expect(captured.config?.engineSocketPath).toBe("/var/folders/xy/podman-api.sock");
        expect(captured.config?.engineBindOwnership).toBe("host-preserved");
    });

    test("a docker pin builds today's exact sandbox config — no engineSocketPath key, no engineBindOwnership", async () => {
        const calls: string[] = [];
        const captured: { config: CreateSandboxClientConfig | null } = { config: null };
        const seams: BootSeams = {
            ...recordingSeams(calls),
            resolveSandboxEngine: async () => {
                calls.push("resolveSandboxEngine");
                return ok({ runtime: runtimes.docker, socketPath: undefined });
            },
            createSandbox: (cfg) => {
                captured.config = cfg;
                return createSandboxClient(cfg);
            },
        };
        const result = await bootHarnessRuntime({ seams, config: testConfig() });

        expect(result.isOk()).toBe(true);
        expect(captured.config).not.toBeNull();
        // Byte-identical to today: the keys must be ABSENT (not present-and-undefined),
        // so dockerode keeps its default resolution and the step tree keeps its modes.
        expect(captured.config !== null && "engineSocketPath" in captured.config).toBe(false);
        expect(captured.config !== null && "engineBindOwnership" in captured.config).toBe(false);
    });

    test("an unresolvable engine socket fails boot with sandbox_engine_unresolved before postgres/lock/launch", async () => {
        const calls: string[] = [];
        const seams: BootSeams = {
            ...recordingSeams(calls),
            resolveSandboxEngine: async () => {
                calls.push("resolveSandboxEngine");
                return err(
                    new ContainerRuntimeError(
                        "Could not resolve the Podman sandbox-engine socket — the Podman machine is not running.\n  Start it with `podman machine start`, then re-run.",
                    ),
                );
            },
        };
        const result = await bootHarnessRuntime({ seams, config: testConfig() });

        const error = result._unsafeUnwrapErr();
        expect(error.type).toBe("sandbox_engine_unresolved");
        // The resolution's runtime-specific remediation rides through verbatim.
        expect(error.type === "sandbox_engine_unresolved" && error.message).toContain("podman machine start");
        // The gate sits ahead of Postgres, the instance lock, the pool, and the DBOS
        // boot, so a failure there reaches none of them (proven by call order: postgres
        // and boot follow the gate, and the lock/pool sit inside the boot's try block).
        expect(calls).not.toContain("postgres");
        expect(calls).not.toContain("boot");
        expect(calls).not.toContain("ingress");
    });

    test("passes the CLI-owned store root for EVERY sandbox, from a config that carries no store key", async () => {
        const calls: string[] = [];
        const captured: { config: CreateSandboxClientConfig | null } = { config: null };
        const storeRoot = seedLibStoreRoot(true);
        const seams: BootSeams = {
            ...recordingSeams(calls),
            createSandbox: (cfg) => {
                captured.config = cfg;
                return createSandboxClient(cfg);
            },
        };
        try {
            // `testConfig()` carries no store key of any kind — there is none left to carry. The pass is
            // unconditional, so the sandbox always gets its `/mnt/libs` bind.
            const result = await bootHarnessRuntime({ seams, config: testConfig() });
            expect(result.isOk()).toBe(true);
            expect(captured.config?.libStorePath).toBe(storeRoot);
            expect(captured.config?.libStorePath).toBe(env.libStoreDir);
        } finally {
            clearLibStoreRoot();
        }
    });

    test("the CLI does not re-do the usability check: an incomplete store still gets the root passed", async () => {
        const calls: string[] = [];
        const captured: { config: CreateSandboxClientConfig | null } = { config: null };
        // The root exists but its active farm carries no inventory. The harness owns the mount check and
        // drops the mount at create time, so the CLI passes the root and never re-implements that check.
        // The boot itself refuses on the INVENTORY, which is a different question — hence the seam here.
        seedLibStoreRoot(false);
        const seams: BootSeams = {
            ...recordingSeams(calls),
            createSandbox: (cfg) => {
                captured.config = cfg;
                return createSandboxClient(cfg);
            },
        };
        try {
            const result = await bootHarnessRuntime({ seams, config: testConfig() });
            expect(result.isOk()).toBe(true);
            expect(captured.config?.libStorePath).toBe(env.libStoreDir);
        } finally {
            clearLibStoreRoot();
        }
    });

    test("the mount path is env.libStoreDir, and no config value can move it", async () => {
        const calls: string[] = [];
        const captured: { config: CreateSandboxClientConfig | null } = { config: null };
        seedLibStoreRoot(true);
        const seams: BootSeams = {
            ...recordingSeams(calls),
            createSandbox: (cfg) => {
                captured.config = cfg;
                return createSandboxClient(cfg);
            },
        };
        try {
            // The config has no store surface at all now: no switch, and no key that states a root. The
            // mount can only ever be the CLI-owned path — the same guarantee `refStorePath: env.refsDir`
            // gives. A config that carried a root would break the store commands, which write
            // env.libStoreDir unconditionally. An unknown key cannot reach the mount either.
            const result = await bootHarnessRuntime({ seams, config: testConfig() });
            expect(result.isOk()).toBe(true);
            expect(captured.config?.libStorePath).toBe(env.libStoreDir);
        } finally {
            clearLibStoreRoot();
        }
    });

    test("the inventory comes from the pool of the store, which is what composition can link", async () => {
        const calls: string[] = [];
        const storeRoot = seedLibStoreRoot(true);
        try {
            const runtime = (await bootHarnessRuntime({ seams: recordingSeams(calls), config: testConfig() }))._unsafeUnwrap();
            expect(runtime).toBeDefined();
            expect(lastCore?.conversation.packagesFile).toBe(join(storeRoot, "packages.txt"));
        } finally {
            clearLibStoreRoot();
        }
    });

    test("an unreadable inventory boots the runtime, so chat answers while the catalog is absent", async () => {
        const calls: string[] = [];
        // The active farm carries no `packages.txt`, so the store inventory is unreadable. The REFUSAL
        // belongs to whatever is about to make a sandbox, not to the boot. Chat, the workspace read surface,
        // and the planner use no package at all, and this is exactly the machine on which the user needs them.
        seedLibStoreRoot(false);
        const seams: BootSeams = { ...recordingSeams(calls), resolveStorePackages: () => null };
        try {
            const runtime = (await bootHarnessRuntime({ seams, config: testConfig() }))._unsafeUnwrap();
            expect(runtime).toBeDefined();
            expect(calls).toContain("boot");
            // The unreadable store reaches the sandbox composition as no `packagesFile`, so nothing describes
            // a store package set the mount does not carry.
            expect(lastCore?.conversation.packagesFile).toBeUndefined();
        } finally {
            clearLibStoreRoot();
        }
    });

    test("a store that is absent altogether boots the same way, and names no inventory", async () => {
        const calls: string[] = [];
        clearLibStoreRoot();
        const seams: BootSeams = { ...recordingSeams(calls), resolveStorePackages: () => null };
        const runtime = (await bootHarnessRuntime({ seams, config: testConfig() }))._unsafeUnwrap();
        expect(runtime).toBeDefined();
        expect(lastCore?.conversation.packagesFile).toBeUndefined();
    });

    test("the extracted image fragment reaches the conversation and data-profile composition bags", async () => {
        const calls: string[] = [];
        const storeRoot = seedLibStoreRoot(true);
        try {
            const runtime = (await bootHarnessRuntime({ seams: recordingSeams(calls), config: testConfig() }))._unsafeUnwrap();
            expect(runtime).toBeDefined();
            // The store inventory and the image fragment are two distinct sources. Both flow to the
            // composition: the store's `packages.txt`, and the extracted image fragment cache path.
            expect(lastCore?.conversation.packagesFile).toBe(join(storeRoot, "packages.txt"));
            expect(lastCore?.conversation.imagePackagesFile).toBe(IMAGE_FRAGMENT_PATH);
            expect(lastCore?.workflows.dataProfile.imagePackagesFile).toBe(IMAGE_FRAGMENT_PATH);
        } finally {
            clearLibStoreRoot();
        }
    });

    test("a failed image-fragment extraction boots the runtime and names no fragment, while the store inventory still flows", async () => {
        const calls: string[] = [];
        const storeRoot = seedLibStoreRoot(true);
        // The extraction gives null — an absent image, an older image with no fragment, or a failed run. The
        // boot never fails on it, and the sandbox composition omits the field, so the harness reports the
        // store tracks alone.
        const seams: BootSeams = { ...recordingSeams(calls), resolveImagePackages: async () => null };
        try {
            const runtime = (await bootHarnessRuntime({ seams, config: testConfig() }))._unsafeUnwrap();
            expect(runtime).toBeDefined();
            expect(calls).toContain("boot");
            // The store source is untouched by the fragment outcome, so it still flows.
            expect(lastCore?.conversation.packagesFile).toBe(join(storeRoot, "packages.txt"));
            // A null fragment is omitted, not passed as null.
            expect(lastCore?.conversation.imagePackagesFile).toBeUndefined();
            expect(lastCore?.workflows.dataProfile.imagePackagesFile).toBeUndefined();
        } finally {
            clearLibStoreRoot();
        }
    });
});

// --- the farm provider (tasks 3.1, 3.2, 3.5) ---------------------------------
//
// There is no active farm at the store level. The harness learns the farm of a sandbox only through the
// provider the composition root supplies. The farm is made WITH its analysis, thus the provider returns
// what the creation made, and it composes no closure of its own: a composition links what a caller names,
// and this caller names nothing.
//
// The mount itself belongs to the harness (`docker-client`), thus these tests drive the provider and the
// mount configuration, and they start no container.

describe("the farm provider the composition root supplies", () => {
    /** The provider of the last boot, from the sandbox-client configuration the CLI built. */
    async function bootProvider(): Promise<(analysisId: string) => Promise<FarmResolution>> {
        const captured: { config: CreateSandboxClientConfig | null } = { config: null };
        const seams: BootSeams = {
            ...recordingSeams([]),
            createSandbox: (cfg) => {
                captured.config = cfg;
                return createSandboxClient(cfg);
            },
        };
        const result = await bootHarnessRuntime({ seams, config: testConfig() });
        expect(result.isOk()).toBe(true);
        const source = captured.config?.farmSource;
        // The CLI owns a farm for each analysis, thus it names that source and no other.
        expect(source?.kind).toBe("per-analysis");
        // The farm bind nests inside the store bind, thus the two must name one store root.
        expect(captured.config?.libStorePath).toBe(env.libStoreDir);
        const resolve = source?.kind === "per-analysis" ? source.resolve : undefined;
        expect(resolve).toBeDefined();
        return async (analysisId: string) => resolve!(analysisId);
    }

    /** The location of a resolved farm, or `undefined` when the provider named none. */
    function locationOf(resolution: FarmResolution): string | undefined {
        return resolution.kind === "farm" ? resolution.location : undefined;
    }

    test("the farm that the creation of the analysis made is returned as it is, and the provider links nothing into it", async () => {
        const storeRoot = seedComposableStore(true);
        try {
            const analysisId = randomUUIDv7();
            // What `analysis new` makes: the farm, empty and with its markers only.
            const made = (await makeEmptyFarm({ storeRoot, analysisId }))._unsafeUnwrap();
            const stamp = lstatSync(join(made.farmPath, "lock.json")).mtimeMs;
            const provider = await bootProvider();

            expect(locationOf(await provider(analysisId))).toBe(made.farmPath);

            // The provider composed nothing: the lock is untouched, and the template's own
            // closure (beta, and the alpha that beta names) is nowhere in this farm.
            expect(lstatSync(join(made.farmPath, "lock.json")).mtimeMs).toBe(stamp);
            expect(readdirSync(made.farmPath).sort()).toEqual(["lock.json", "meta.json", "packages.txt"]);
        } finally {
            clearLibStoreRoot();
        }
    });

    test("an absent farm resolves by making an empty one, thus a store that arrived later still serves the analysis", async () => {
        const storeRoot = seedComposableStore(true);
        try {
            const provider = await bootProvider();
            const analysisId = randomUUIDv7();

            const farm = locationOf(await provider(analysisId));

            expect(farm).toBe(join(storeRoot, "farms", analysisId));
            // The two completeness markers the harness usability gate requires.
            expect(existsSync(join(farm as string, "packages.txt"))).toBe(true);
            expect(existsSync(join(farm as string, "meta.json"))).toBe(true);
            // And no package: the healed farm is the empty farm that the creation would have made.
            expect(existsSync(join(farm as string, "python"))).toBe(false);
        } finally {
            clearLibStoreRoot();
        }
    });

    test("two analyses get two farms, and each one starts empty", async () => {
        const storeRoot = seedComposableStore(true);
        try {
            const provider = await bootProvider();
            const first = randomUUIDv7();
            const second = randomUUIDv7();

            const farms = [locationOf(await provider(first)), locationOf(await provider(second))];

            expect(farms).toEqual([join(storeRoot, "farms", first), join(storeRoot, "farms", second)]);
            for (const farm of farms) expect(readdirSync(farm as string).sort()).toEqual(["lock.json", "meta.json", "packages.txt"]);
            // The template belongs to composition and never to a sandbox.
            expect(farms).not.toContain(join(storeRoot, "farms", "catalog"));
        } finally {
            clearLibStoreRoot();
        }
    });

    test("a farm that is already there is returned as it is, thus a second sandbox writes nothing again", async () => {
        const storeRoot = seedComposableStore(true);
        try {
            const provider = await bootProvider();
            const analysisId = randomUUIDv7();
            const farm = locationOf(await provider(analysisId)) as string;
            const stamp = lstatSync(join(farm, "lock.json")).mtimeMs;

            expect(locationOf(await provider(analysisId))).toBe(farm);
            expect(lstatSync(join(storeRoot, "farms", analysisId, "lock.json")).mtimeMs).toBe(stamp);
        } finally {
            clearLibStoreRoot();
        }
    });

    test("a farm that cannot be made returns no farm, and the refusal carries the reason", async () => {
        // A store with no catalog template: a farm has no architecture to record.
        seedComposableStore(false);
        try {
            const provider = await bootProvider();
            const analysisId = randomUUIDv7();

            const resolution = await provider(analysisId);

            expect(resolution.kind).toBe("unavailable");
            // The harness refuses that ONE sandbox and names this reason.
            expect(resolution.kind === "unavailable" ? resolution.reason : "").toContain("catalog template");
        } finally {
            clearLibStoreRoot();
        }
    });
});

// --- the farm-extension seam (tasks 11.1, 11.3) ------------------------------
//
// `link_packages` reaches the pool through this seam. It runs in the harness host process, beside the tool
// that calls it, thus it links and it acquires NOTHING: it starts no container, it opens no network
// connection, and it starts no `inflexa` child. An acquisition is a host action, before a run.

describe("the farm-extension seam the composition root binds", () => {
    /** The fixture pool holds `beta`, which names `alpha`. Both are Python store directories. */
    const BETA = "beta-0.4.1-000000000000bbbb";

    /**
     * Run one seam call while each child-process call of Bun refuses.
     *
     * An acquisition is the one thing that this seam must never do. Each route to one leaves this
     * process: the provisioner container, and the `inflexa` child that a host command spawns. A stub
     * that throws fails the test at either call, and the name that it captured says which one ran.
     */
    async function withoutAChildProcess<T>(body: () => Promise<T>): Promise<{ readonly value: T; readonly spawned: string[] }> {
        const spawned: string[] = [];
        const realSpawn = Bun.spawn;
        const realSpawnSync = Bun.spawnSync;
        const refuse =
            (name: string) =>
            (...args: unknown[]): never => {
                spawned.push(`${name}: ${JSON.stringify(args[0])}`);
                throw new Error(`the seam started a child process through ${name}`);
            };
        try {
            // A stub can never satisfy the overloaded signature of one of these built-ins,
            // thus each write goes through `unknown`. It is sound because the stub is total:
            // each call records and throws, and the `finally` below puts the real one back
            // whatever the body does.
            Bun.spawn = refuse("Bun.spawn") as unknown as typeof Bun.spawn;
            Bun.spawnSync = refuse("Bun.spawnSync") as unknown as typeof Bun.spawnSync;
            return { value: await body(), spawned };
        } finally {
            Bun.spawn = realSpawn;
            Bun.spawnSync = realSpawnSync;
        }
    }

    test("links what the pool holds, and it starts no child process and acquires nothing", async () => {
        const storeRoot = seedComposableStore(true);
        try {
            const analysisId = randomUUIDv7();
            (await makeEmptyFarm({ storeRoot, analysisId }))._unsafeUnwrap();
            const pool = readdirSync(join(storeRoot, "store")).sort();

            const { value: outcomes, spawned } = await withoutAChildProcess(() =>
                linkPackagesIntoFarm(storeRoot, analysisId, [{ kind: "distribution", requirement: "beta" }]),
            );

            expect(spawned).toEqual([]);
            expect(outcomes).toEqual([{ kind: "linked", requested: "beta", name: "beta", version: "0.4.1" }]);
            // The farm links the package and the closure of it, and the pool gained nothing:
            // the seam moved no bytes and it resolved no version.
            expect(lstatSync(join(storeRoot, "farms", analysisId, "python", "site-packages", "beta")).isSymbolicLink()).toBe(true);
            expect(lstatSync(join(storeRoot, "farms", analysisId, "python", "site-packages", "alpha")).isSymbolicLink()).toBe(true);
            expect(readdirSync(join(storeRoot, "store")).sort()).toEqual(pool);
        } finally {
            clearLibStoreRoot();
        }
    });

    test("a package that the pool does not hold is absent with a reason, and nothing is acquired for it", async () => {
        const storeRoot = seedComposableStore(true);
        try {
            const analysisId = randomUUIDv7();
            (await makeEmptyFarm({ storeRoot, analysisId }))._unsafeUnwrap();
            const pool = readdirSync(join(storeRoot, "store")).sort();

            const { value: outcomes, spawned } = await withoutAChildProcess(() =>
                linkPackagesIntoFarm(storeRoot, analysisId, [
                    { kind: "distribution", requirement: "scanpy" },
                    { kind: "import", module: "sklearn" },
                ]),
            );

            expect(spawned).toEqual([]);
            // One outcome for each request, in the order of the requests.
            expect(outcomes.map((outcome) => outcome.kind)).toEqual(["absent", "absent"]);
            // The reason carries the remedy, because the harness names no command of its
            // own: a managed deployment runs the same harness and holds no `inflexa`.
            expect(outcomes[0]).toEqual({
                kind: "absent",
                requested: "scanpy",
                reason: 'the store holds no package named "scanpy" — run `inflexa store add scanpy` to acquire it',
                acquisitionPossible: true,
            });
            expect(outcomes[1]).toEqual({
                kind: "absent",
                requested: "sklearn",
                reason: 'no package of the store gives the module "sklearn" — run `inflexa store add <package>` for the package that gives it',
                acquisitionPossible: true,
            });
            // A refusal acquires nothing and links nothing: the pool and the farm are as they were.
            expect(readdirSync(join(storeRoot, "store")).sort()).toEqual(pool);
            expect(readdirSync(join(storeRoot, "farms", analysisId)).sort()).toEqual(["lock.json", "meta.json", "packages.txt"]);
        } finally {
            clearLibStoreRoot();
        }
    });

    test("a package that the farm already links is present, and a version the pool does not hold names the versions it has", async () => {
        const storeRoot = seedComposableStore(true);
        try {
            const analysisId = randomUUIDv7();
            (await makeEmptyFarm({ storeRoot, analysisId }))._unsafeUnwrap();
            (await extendFarm({ storeRoot, analysisId, roots: [BETA] }))._unsafeUnwrap();

            const outcomes = await linkPackagesIntoFarm(storeRoot, analysisId, [
                { kind: "distribution", requirement: "beta" },
                { kind: "distribution", requirement: "beta==9.9.9" },
                { kind: "distribution", requirement: "rpkga==9.9" },
            ]);

            expect(outcomes[0]).toEqual({ kind: "present", requested: "beta", name: "beta", version: "0.4.1" });
            expect(outcomes[1]).toEqual({
                kind: "absent",
                requested: "beta==9.9.9",
                reason:
                    'the store holds "beta" at 0.4.1, and not at 9.9.9 — run `inflexa store add beta==9.9.9` to acquire that version, ' +
                    "or name one of the versions above",
                acquisitionPossible: true,
            });
            // The store cannot acquire an R package at all, thus the mark says so and the
            // reason names no remedy, because no retry and no later attempt can change it.
            expect(outcomes[2]).toEqual({
                kind: "absent",
                requested: "rpkga==9.9",
                reason: 'the store holds "rpkga" at 1.0, and not at 9.9, and this store acquires no R package, thus no retry of that version succeeds',
                acquisitionPossible: false,
            });
        } finally {
            clearLibStoreRoot();
        }
    });
});

// The usage-recorder seam. `assembleCoreRuntime` takes the recorder on `core` and stamps it onto the
// conversation agent AND each workflow deps bag itself — which is why `ConversationAssemblyDeps`,
// `sandboxStep`, `buildExecuteAnalysis`, `executeTargetAssessment`, and `dataProfile` all `Omit` the
// field. A bag carrying its own would be the half-wired ledger the harness's `Omit` exists to make
// unrepresentable.
//
// Supplying it there is NECESSARY BUT NOT SUFFICIENT, and that gap is why the handle carries it too.
// `runAgent` reads the recorder from the OPTIONS it is invoked with and falls back to the harness's
// no-op when the field is absent — it never reads one off the agent definition — so the stamping
// covers exactly the loops whose options the harness itself builds. A loop the CLI invokes directly
// (the chat turn) is covered only by that call site passing this instance, which is what
// `HarnessRuntime.usageRecorder` exists for and what the last test here pins.
describe("bootHarnessRuntime — the usage-recorder seam", () => {
    /** A record shaped like a chat-path call, used to prove the supplied recorder is inert-but-live rather than merely present. */
    function chatRecord(): LlmUsageRecord {
        return {
            recordKey: `boot-probe-${randomUUIDv7()}`,
            agentId: "tui-chat",
            callPath: ["tui-chat"],
            scope: { kind: "analysis", analysisId: "ana-boot-probe", threadId: "thr-boot-probe" },
            usage: { inputTokens: 1, outputTokens: 1 },
        };
    }

    test("supplies exactly one recorder on core, reaching the conversation, workflow, and data-profile loops through it", async () => {
        const calls: string[] = [];
        await bootHarnessRuntime({ seams: recordingSeams(calls), config: testConfig() });

        const core = lastCore;
        expect(core?.usageRecorder?.record).toBeInstanceOf(Function);
        // Each bag the cohort registers — the conversation agent's, both run-engine workflows', the
        // target-assessment workflow's, and the data profile's — arrives WITHOUT a recorder of its own,
        // so the one on `core` is the only thing any of them can be stamped with.
        const child = async () => ({ status: "complete" as const, durationMs: 0, finishReason: null, error: null });
        const bags = [
            core?.conversation,
            core?.workflows.sandboxStep,
            core?.workflows.buildExecuteAnalysis(child),
            core?.workflows.executeTargetAssessment,
            core?.workflows.dataProfile,
        ];
        for (const bag of bags) {
            expect(bag).toBeDefined();
            expect(Object.hasOwn(bag ?? {}, "usageRecorder")).toBe(false);
        }
    });

    test("the supplied recorder is the ledger realization, and absorbs a record without throwing", async () => {
        const calls: string[] = [];
        await bootHarnessRuntime({ seams: recordingSeams(calls), config: testConfig() });

        // Not the harness's `createNoopUsageRecorder` fallback: this one writes, and it is total — the
        // loop delivers bare, so a throw here would fail the turn that made the call.
        expect(() => lastCore?.usageRecorder?.record(chatRecord())).not.toThrow();
    });

    test("the handle exposes the SAME instance the composition root supplied, for the loops the cli drives itself", async () => {
        const calls: string[] = [];
        const runtime = (await bootHarnessRuntime({ seams: recordingSeams(calls), config: testConfig() }))._unsafeUnwrap();

        // Identity, not merely a recorder: the chat turn passes this into its own `runAgent` options,
        // and a second realization here would be a second writer of one table — while anything OTHER
        // than the stamped instance would leave the turn's rows in a different accounting than every
        // workflow's. `turn.ts` is where it is consumed; `usage_ledger.test.ts` proves a row lands.
        // `defined` rides along so the identity claim cannot pass vacuously on two `undefined`s.
        expect({ defined: lastCore?.usageRecorder !== undefined, same: runtime.usageRecorder === lastCore?.usageRecorder }).toEqual({
            defined: true,
            same: true,
        });
    });

    test("the recorder is built once per runtime, not per boot call", async () => {
        const calls: string[] = [];
        const seams = recordingSeams(calls);
        const cfg = testConfig();
        await bootHarnessRuntime({ seams, config: cfg });
        const first = lastCore?.usageRecorder;

        // The second call rides the memoized runtime, so `boot` — and with it the recorder
        // construction — never runs again. One runtime reports to one ledger through one instance.
        await bootHarnessRuntime({ seams, config: cfg });
        expect(lastCore?.usageRecorder).toBe(first);
        expect(calls.filter((c) => c === "boot")).toHaveLength(1);
    });
});

// The direct-mode auth-injecting fetch (the config.fetch seam): per-request scheme rewrite + one 401
// refresh/retry. Driven with a recording underlying fetch so the OUTGOING headers and retry count are the
// assertions — no real network, no provider boot.
describe("buildAuthInjectingFetch", () => {
    /** A recording underlying fetch: captures each request's headers and returns the queued statuses in order. */
    function recordingFetch(statuses: number[]): { fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>; seen: Headers[] } {
        const seen: Headers[] = [];
        let i = 0;
        return {
            seen,
            fetch: (_input, init) => {
                seen.push(new Headers(init?.headers));
                return Promise.resolve(new Response(null, { status: statuses[i++] ?? 200 }));
            },
        };
    }

    /** A fixed, expiry-less credential source for the header-rewrite cases (get and forceRefresh yield the same token). */
    function fixedSource(token: string, scheme: CredentialScheme): CredentialSource {
        const cred = ok<Credential, CredentialError>({ token, scheme });
        return { get: () => Promise.resolve(cred), forceRefresh: () => Promise.resolve(cred) };
    }

    test("bearer scheme sets Authorization: Bearer and strips the SDK's x-api-key", async () => {
        const { fetch: underlying, seen } = recordingFetch([200]);
        const f = buildAuthInjectingFetch(fixedSource("btok", "bearer"), underlying);
        // The AI SDK's anthropic provider sets x-api-key from the placeholder apiKey — the bearer path must remove it.
        await f("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": "placeholder" } });
        expect(seen[0]!.get("authorization")).toBe("Bearer btok");
        expect(seen[0]!.get("x-api-key")).toBeNull();
    });

    test("x-api-key scheme sets x-api-key and strips the SDK's placeholder Authorization", async () => {
        const { fetch: underlying, seen } = recordingFetch([200]);
        const f = buildAuthInjectingFetch(fixedSource("xtok", "x-api-key"), underlying);
        // An openai-compatible endpoint derives `Authorization: Bearer <placeholder>` from the placeholder
        // apiKey; the x-api-key branch must remove it so the stale placeholder never rides along.
        await f("https://gw.corp/v1/messages", { method: "POST", headers: { authorization: "Bearer placeholder" } });
        expect(seen[0]!.get("x-api-key")).toBe("xtok");
        expect(seen[0]!.get("authorization")).toBeNull();
    });

    test("an HTTP 401 forces exactly one refresh + retry with the new token", async () => {
        const { fetch: underlying, seen } = recordingFetch([401, 200]);
        let refreshCount = 0;
        let token = "tok-1";
        const source: CredentialSource = {
            get: () => Promise.resolve(ok<Credential, CredentialError>({ token, scheme: "bearer" })),
            forceRefresh: () => {
                refreshCount++;
                token = "tok-2";
                return Promise.resolve(ok<Credential, CredentialError>({ token, scheme: "bearer" }));
            },
        };
        const response = await buildAuthInjectingFetch(source, underlying)("https://api.anthropic.com/v1/messages", { method: "POST" });

        expect(response.status).toBe(200);
        expect(refreshCount).toBe(1); // exactly one forced refresh
        expect(seen).toHaveLength(2); // one retry only
        expect(seen[0]!.get("authorization")).toBe("Bearer tok-1");
        expect(seen[1]!.get("authorization")).toBe("Bearer tok-2");
    });

    test("a persistent 401 retries only once, then surfaces the 401", async () => {
        const { fetch: underlying, seen } = recordingFetch([401, 401]);
        let refreshCount = 0;
        const source: CredentialSource = {
            get: () => Promise.resolve(ok<Credential, CredentialError>({ token: "t", scheme: "bearer" })),
            forceRefresh: () => {
                refreshCount++;
                return Promise.resolve(ok<Credential, CredentialError>({ token: "t2", scheme: "bearer" }));
            },
        };
        const response = await buildAuthInjectingFetch(source, underlying)("https://api.anthropic.com/v1/messages", {});

        expect(response.status).toBe(401);
        expect(refreshCount).toBe(1);
        expect(seen).toHaveLength(2); // original + exactly one retry, never a third attempt
    });

    test("a credential-resolution failure rejects the fetch (its throwing contract) with an actionable message", async () => {
        const { fetch: underlying } = recordingFetch([200]);
        const source: CredentialSource = {
            get: () => Promise.resolve(err<Credential, CredentialError>({ type: "env_var_unset", var: "MISSING" })),
            forceRefresh: () => Promise.resolve(err<Credential, CredentialError>({ type: "env_var_unset", var: "MISSING" })),
        };
        await expect(buildAuthInjectingFetch(source, underlying)("https://x/messages", {})).rejects.toThrow(/MISSING/);
    });
});
