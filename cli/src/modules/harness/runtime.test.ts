import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUIDv7 } from "bun";
import { ok, okAsync, err } from "neverthrow";
import type { EmbeddingProvider } from "@inflexa-ai/harness";

import { env } from "../../lib/env.ts";
import { instanceLockPath } from "../../lib/lock.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";
import { bootHarnessRuntime, __resetHarnessRuntimeForTest, type BootSeams } from "./runtime.ts";
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

let skillsDir: string;
let templatesDir: string;

function testConfig(overrides: Partial<ResolvedHarnessConfig> = {}): ResolvedHarnessConfig {
    skillsDir = join(tmpdir(), `harness-runtime-test-skills-${randomUUIDv7()}`);
    templatesDir = join(tmpdir(), `harness-runtime-test-templates-${randomUUIDv7()}`);
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(templatesDir, { recursive: true });
    return {
        model: "claude-test-model",
        bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
        sandboxImage: "ghcr.io/inflexa-ai/sandbox-python-r:latest",
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
        sweepEphemeral: async () => {
            calls.push("sweepEphemeral");
        },
        assemble: (deps) => {
            calls.push("assemble");
            // The boot hands the composition root the run-engine realizations on the
            // workflow deps and the conversation bundle. `assembleCoreRuntime` owns
            // child-before-parent registration internally, so the offline seam only
            // asserts the deps arrived shaped correctly, then returns the callables.
            const { workflows, conversation } = deps;
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
            // shares (design D2) plus the RESOLVED provider instance advertising its
            // index width. The ONE resolver instance built at boot threads to every
            // bundle, so identity (not just shape) is the invariant.
            expect(workflows.dataProfile.resolveWorkspaceRoot).toBeInstanceOf(Function);
            expect(workflows.dataProfile.resolveWorkspaceRoot).toBe(workflows.sandboxStep.resolveWorkspaceRoot);
            expect(workflows.dataProfile.resolveWorkspaceRoot).toBe(conversation.resolveWorkspaceRoot);
            expect(workflows.dataProfile.skillsDir).toBe(skillsDir);
            expect(workflows.dataProfile.embedding.dimensions).toBe(1536);
            expect(workflows.dataProfile.embedding.embed).toBeInstanceOf(Function);
            // The ephemeral + target-assessment bundles carry the shared backends.
            expect(workflows.ephemeral.sandboxClient).toBeDefined();
            expect(workflows.executeTargetAssessment.chatProvider).toBeDefined();
            // The conversation bundle carries the local realizations: the configured
            // templates tree, the unavailable-preview factory, and the shared launcher.
            expect(conversation.templatesDir).toBe(templatesDir);
            expect(conversation.createPreviewPublisher).toBeInstanceOf(Function);
            expect(conversation.runLauncher.launch).toBeInstanceOf(Function);
            return {
                conversationAgent: { id: "conversation-agent", systemPrompt: "", model: "claude-test-model", tools: [], maxIterations: 50 },
                workflows: {
                    executeAnalysis: async () => ({ runId: "", workflowId: "", status: "completed", completedSteps: [], failedSteps: [], canceledSteps: [] }),
                    sandboxStep: async () => ({ status: "complete", durationMs: 0, finishReason: null, error: null }),
                    executeTargetAssessment: async () => ({ assessmentId: "", status: "completed", bytes: 0 }),
                    dataProfile: async () => {},
                    ephemeral: async () => ({ text: "", durationMs: 0, stepsUsed: 0 }),
                },
            };
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
    rmSync(skillsDir, { recursive: true, force: true });
    rmSync(templatesDir, { recursive: true, force: true });
});

describe("bootHarnessRuntime", () => {
    test("boots in the contract order: prereqs → postgres → schema init → ephemeral sweep → assemble → crons → launch", async () => {
        const calls: string[] = [];
        const result = await bootHarnessRuntime({ seams: recordingSeams(calls), config: testConfig() });

        const runtime = result._unsafeUnwrap();
        // The embedding provider resolves first (local-embeddings boots
        // ahead of the proxy key). The ephemeral sweep runs strictly between schema
        // init and assembly (cancel stale rows before recovery can
        // re-dispatch them), then the composition root registers the whole workflow
        // cohort in one call, then the three sandbox-hygiene crons, all before the
        // single launch. The CLI is a poll-mode embedder, so it binds NO
        // callback ingress — `startIngress` is never called.
        expect(calls).toEqual([
            "resolveEmbedding",
            "readKey",
            "probeEmbedding",
            "postgres",
            "initState",
            "sweepEphemeral",
            "assemble",
            "registerReaper",
            "registerWatchdog",
            "registerNotificationSweep",
            "launch",
        ]);
        expect(calls).not.toContain("ingress");
        // No `models.agents` and a single `harness.model` (claude-test-model): both agents resolve to it
        // and share ONE underlying provider instance (D-SHARE). Each agent carries its own swappable HANDLE
        // (so a later live switch of one agent re-points only that agent — agent-model-selection D4), but the
        // handles delegate to the SAME inner, which is the referential invariant that matters.
        expect(runtime.conversation.model).toBe("claude-test-model");
        expect(runtime.sandbox.model).toBe("claude-test-model");
        expect(agentProviderInner(runtime.sandbox.provider)).toBe(agentProviderInner(runtime.conversation.provider));
        expect(runtime.triggerDeps.workflow).toBeInstanceOf(Function);
        // The assembled conversation agent + its agent provider are on the handle (the `chat` command
        // drives `runAgent(conversationAgent, …, conversation.provider)`).
        expect(runtime.conversationAgent.id).toBe("conversation-agent");
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

    test("sweeps ephemerals after schema init, assembles once before launch, and registers the whole cohort pre-launch", async () => {
        const calls: string[] = [];
        await bootHarnessRuntime({ seams: recordingSeams(calls), config: testConfig() });

        const initState = calls.indexOf("initState");
        const sweep = calls.indexOf("sweepEphemeral");
        const assemble = calls.indexOf("assemble");
        const launch = calls.indexOf("launch");
        // The sweep is the single race-free pre-launch cancel point: it
        // must follow schema init and precede assembly (which registers the ephemeral
        // workflow) — and, transitively, launch.
        expect(initState).toBeLessThan(sweep);
        expect(sweep).toBeLessThan(assemble);
        // Child-before-parent ordering now lives inside `assembleCoreRuntime` (one
        // call), so the boot only proves the whole cohort — the composition root plus
        // the three crons — lands before the one launch (recovery finds workflows by
        // registered name at launch; nothing may register after).
        const registrations = ["assemble", "registerReaper", "registerWatchdog", "registerNotificationSweep"];
        for (const name of registrations) {
            const at = calls.indexOf(name);
            expect(at).toBeGreaterThanOrEqual(0);
            expect(at).toBeLessThan(launch);
        }
        expect(calls.filter((c) => c === "assemble")).toHaveLength(1);
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
        for (const name of ["sweepEphemeral", "assemble", "registerReaper", "registerWatchdog", "registerNotificationSweep", "launch"]) {
            expect(calls).not.toContain(name);
        }
    });

    test("resolves the model from the proxy only when config has none — both agents share the ONE auto-resolve", async () => {
        const calls: string[] = [];
        const runtime = (await bootHarnessRuntime({ seams: recordingSeams(calls), config: testConfig({ model: null }) }))._unsafeUnwrap();

        // Both agents fall through to the proxy default; the auto-resolve is memoized, so `/models` is hit
        // ONCE and both agents' swappable handles delegate to the resulting id's single provider instance.
        expect(runtime.conversation.model).toBe("claude-from-proxy");
        expect(runtime.sandbox.model).toBe("claude-from-proxy");
        expect(agentProviderInner(runtime.sandbox.provider)).toBe(agentProviderInner(runtime.conversation.provider));
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
        // The whole sequence ran exactly once — `assemble` (registration cohort) and `launch` (its tail)
        // each appear a single time, so no second boot registered anything.
        expect(calls.filter((c) => c === "assemble")).toHaveLength(1);
        expect(calls.filter((c) => c === "launch")).toHaveLength(1);
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
        expect(calls).toContain("launch");
    });

    test("an explicitly-configured off-family model is trusted (the guard only checks the auto path)", async () => {
        const calls: string[] = [];
        const result = await bootHarnessRuntime({
            seams: recordingSeams(calls),
            config: testConfig({ model: "gpt-4o" }),
            connection: cliproxyConnection("anthropic"),
        });

        expect(result._unsafeUnwrap().sandbox.model).toBe("gpt-4o");
        expect(calls).toContain("launch");
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
        expect(calls).toContain("launch");
    });

    test("direct mode with no configured model fails boot with model_required naming BOTH agents (no proxy auto-resolve)", async () => {
        const calls: string[] = [];
        const result = await bootHarnessRuntime({
            seams: recordingSeams(calls),
            config: testConfig({ model: null }),
            connection: directConnection(),
        });

        // Neither agent has an override nor a harness.model fallback, so the one actionable error names both.
        expect(result._unsafeUnwrapErr()).toMatchObject({ type: "model_required", agents: ["conversation", "sandbox"] });
        expect(calls).not.toContain("resolveModel");
        expect(calls).not.toContain("postgres");
    });

    test("direct mode with a per-agent override for only one agent fails naming just the unresolved agent", async () => {
        const calls: string[] = [];
        const result = await bootHarnessRuntime({
            seams: recordingSeams(calls),
            config: testConfig({ model: null }),
            connection: directConnection({ agents: { conversation: "deepseek-chat" } }),
        });

        // conversation resolves from its override; sandbox has neither an override nor harness.model.
        expect(result._unsafeUnwrapErr()).toMatchObject({ type: "model_required", agents: ["sandbox"] });
        expect(calls).not.toContain("postgres");
    });

    test("direct mode with both agents overridden boots on the distinct per-agent models, over two provider instances", async () => {
        const calls: string[] = [];
        const result = await bootHarnessRuntime({
            seams: recordingSeams(calls),
            config: testConfig({ model: null }),
            connection: directConnection({ agents: { conversation: "deepseek-chat", sandbox: "deepseek-reasoner" } }),
        });

        const runtime = result._unsafeUnwrap();
        expect(runtime.conversation.model).toBe("deepseek-chat");
        expect(runtime.sandbox.model).toBe("deepseek-reasoner");
        // Distinct resolved models ⇒ two provider instances over the one connection (D-SHARE).
        expect(runtime.sandbox.provider).not.toBe(runtime.conversation.provider);
        expect(calls).toContain("launch");
    });

    test("per-agent resolution order: an agent override wins over harness.model, which is the both-agents fallback", async () => {
        const calls: string[] = [];
        // harness.model = claude-test-model is the fallback; only sandbox overrides it. conversation
        // therefore rides the fallback and sandbox rides its own override — the D2 order, per agent.
        const result = await bootHarnessRuntime({
            seams: recordingSeams(calls),
            config: testConfig({ model: "claude-test-model" }),
            connection: cliproxyConnection("anthropic", { sandbox: "claude-sonnet-4-5" }),
        });

        const runtime = result._unsafeUnwrap();
        expect(runtime.conversation.model).toBe("claude-test-model");
        expect(runtime.sandbox.model).toBe("claude-sonnet-4-5");
        expect(runtime.sandbox.provider).not.toBe(runtime.conversation.provider);
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
        expect(calls).toContain("launch");
    });

    test("direct mode with an unset INFLEXA_MODEL_API_KEY fails boot naming the variable", async () => {
        const calls: string[] = [];
        const seams: BootSeams = {
            ...recordingSeams(calls),
            readModelApiKey: () => {
                calls.push("readModelApiKey");
                return undefined;
            },
        };
        const result = await bootHarnessRuntime({ seams, config: testConfig({ model: "some-alias-v2" }), connection: directConnection() });

        expect(result._unsafeUnwrapErr()).toMatchObject({ type: "model_api_key_missing" });
        expect(calls).not.toContain("readKey");
        expect(calls).not.toContain("postgres");
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

    test("a throwing launch is bridged to runtime_boot_failed", async () => {
        const calls: string[] = [];
        const seams: BootSeams = {
            ...recordingSeams(calls),
            launch: async () => {
                calls.push("launch");
                throw new Error("dbos exploded");
            },
        };
        const result = await bootHarnessRuntime({ seams, config: testConfig() });

        // The DBOS-SDK throw is bridged to a Result. Poll mode bound no ingress, so
        // the failure path has nothing to tear down but the (in-process-reclaimable)
        // runtime lock.
        expect(result._unsafeUnwrapErr()).toMatchObject({ type: "runtime_boot_failed" });
        expect(calls).toContain("launch");
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
            expect(calls).not.toContain("launch");
        } finally {
            rmSync(lockPath, { force: true });
            holder.kill();
            await holder.exited;
        }
    });
});
