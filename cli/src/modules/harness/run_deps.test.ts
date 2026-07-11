import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
    createAnthropicProvider,
    createEmbeddingProvider,
    createNoopBillingResolver,
    createPool,
    createSandboxClient,
    createWorkspaceFilesystem,
    SANDBOX_AGENT_META,
    type AgentSession,
    type ArtifactRegistrationInput,
    type ChatProvider,
    type ExecuteAnalysisDeps,
    type ProvenanceCollector,
    type RunAuthorizer,
    type SandboxAgentBuildContext,
} from "@inflexa-ai/harness";

import { Bus } from "../../lib/bus.ts";
import type { StampedEvent } from "../../types/events.ts";
import { createSwappableSandboxEmitters } from "./prov_bridge.ts";
import { buildExecuteAnalysisDeps, buildSandboxStepDeps, type RunEngineComposition } from "./run_deps.ts";

// All factories below construct lazily (pg pools connect on first query; the
// SDK clients open no socket at construction), so the whole module builds
// offline — no Postgres, proxy, embeddings endpoint, or Docker daemon.
//
// `sandbox` overrides the SANDBOX agent's model id (the agent every run-engine builder draws), so a test
// can prove an arbitrary configured provider/model flows into the recorded identity with no id sniffing;
// the conversation agent stays fixed since no run-engine builder reads it.
function testComposition(overrides: { sandbox?: string; modelProvider?: string } = {}): RunEngineComposition {
    const resolveBilling = createNoopBillingResolver();
    const pool = createPool({ host: "localhost", port: "5", database: "d", user: "u", password: "p", sslMode: "disable" });
    // A `<base>/<analysisId>` resolver keeps the byte layout the old fixed base
    // produced, so every expected path below stays literal and readable.
    const resolveWorkspaceRoot = (analysisId: string): string => join("/tmp/sessions", analysisId);
    const makeProvider = (model: string): ChatProvider => createAnthropicProvider({ baseURL: "http://proxy.test", token: "t", model, resolveBilling });
    const sandboxModel = overrides.sandbox ?? "claude-test";
    const modelProvider = overrides.modelProvider ?? "anthropic";
    return {
        pool,
        embedding: createEmbeddingProvider({ baseURL: "http://emb.test/v1", token: "t", model: "text-embedding-3-small", resolveBilling }),
        sandboxClient: createSandboxClient({
            pool,
            env: { backend: "docker", namespace: "" },
            cortexBaseUrl: "http://host.docker.internal:1",
            image: "img",
            resourceLimits: { maxCpu: 1, maxMemoryGb: 1, maxGpuCount: 0 },
            resolveWorkspaceRoot,
        }),
        workspaceFs: createWorkspaceFilesystem({ resolveWorkspaceRoot }),
        resolveWorkspaceRoot,
        conversation: { provider: makeProvider("claude-test"), model: "claude-test" },
        sandbox: { provider: makeProvider(sandboxModel), model: sandboxModel },
        // The connection's configured provider slug (boot feeds it verbatim), shared across agents.
        modelProvider,
        // The REAL swappable holder stamped with the boot name — the same stable handles boot injects, so
        // `comp.sandboxEmitters.swap(...)` drives the exact live-switch path the snapshot-safety tests need.
        sandboxEmitters: createSwappableSandboxEmitters(`${modelProvider}/${sandboxModel}`),
        skillsDir: "/tmp/skills",
        bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
    };
}

// A minimal build context. `buildAgent` reads only the analysis/run/step ids,
// the agent id, the write prefix, and the per-call accessors; the sandbox /
// lineage-collector / blocker-holder are captured by tool closures at
// composition and never dereferenced there — so empty placeholders are safe,
// and the `RunSession` fields the ctx type carries are never read. The
// `as unknown as` cast bridges those unread placeholder-typed fields, which
// the cli cannot construct without deep-importing harness internals.
function fakeBuildContext(agentId: string, stepWritePrefix: string): SandboxAgentBuildContext {
    return {
        input: { analysisId: "an-1", runId: "run-1", stepId: "step-1", agentId },
        workflowId: "run-1",
        stepWritePrefix,
        nextFunctionId: () => "fn-0",
        deadlineMs: () => Date.now() + 60_000,
        lineageCollector: {},
        blockerHolder: {},
        sandbox: {},
    } as unknown as SandboxAgentBuildContext;
}

// The composed deps carry the bus-adapter registry + the run-lifecycle emitter (not the old no-op
// stub), so registering/observing through them lands `prov.*` events on the bus. The adapter's own
// per-entry behavior is covered in prov_bridge.test.ts; here we assert only the WIRING.
describe("run-engine provenance wiring", () => {
    let captured: StampedEvent[] = [];
    function spy(event: StampedEvent): void {
        captured.push(event);
    }
    afterEach(() => {
        Bus.off("inflexa", spy);
    });

    // The bus adapter reads `getRecords()` + `getTrackedInputs()` off the collector and never touches
    // the session; both return empty here so only the file event fires.
    const emptyCollector = { getRecords: () => [], getTrackedInputs: () => [] } as unknown as ProvenanceCollector;
    const noSession = {} as unknown as AgentSession;

    test("buildSandboxStepDeps wires the bus-adapter registry — registering emits provenance events", async () => {
        const deps = buildSandboxStepDeps(testComposition());
        captured = [];
        Bus.on("inflexa", spy);

        const input: ArtifactRegistrationInput = {
            resourceId: "an-1",
            runId: "run-1",
            stepId: "step-1",
            artifacts: [{ stepId: "step-1", runId: "run-1", path: "output/r.csv", size: 7, type: "output", hash: "sha256:deadbeef" }],
            collector: emptyCollector,
        };
        const result = await deps.artifactRegistry.register(input, noSession);

        // No step event from the registry — the scheduler settlement owns step lifecycle now.
        expect(captured.map((e) => e.type)).toEqual(["prov.file_written"]);
        expect(result.registered).toHaveLength(1);
        expect(result.registered[0]!.path).toBe("runs/run-1/step-1/output/r.csv");
    });

    test("buildExecuteAnalysisDeps carries emitProvenance, which lands run events on the bus", () => {
        // `sandboxStepCallable` + `runAuthorizer` are stored, never invoked by the builder.
        const callable = (async () => ({})) as unknown as ExecuteAnalysisDeps["sandboxStepCallable"];
        const authorizer = {} as unknown as RunAuthorizer;
        const deps = buildExecuteAnalysisDeps(testComposition(), callable, authorizer);

        expect(deps.emitProvenance).toBeInstanceOf(Function);

        captured = [];
        Bus.on("inflexa", spy);
        deps.emitProvenance!({ type: "run_started", analysisId: "an-1", runId: "run-1", planSummary: "plan", stepCount: 1, atMs: 1_700_000_000_000 });

        expect(captured).toHaveLength(1);
        expect(captured[0]!.type).toBe("prov.run_started");

        // The emitter closed over the composition's model id — a settled step records which model
        // drove it (the wiring half of the model-agent record; the mapping itself is prov_bridge's).
        deps.emitProvenance!({ type: "step_completed", analysisId: "an-1", runId: "run-1", stepId: "step-1", status: "completed", atMs: 1_700_000_001_000 });
        const stepEvent = captured[1]!;
        if (stepEvent.type !== "prov.step_completed") throw new Error("expected prov.step_completed");
        expect(stepEvent.model).toBe("anthropic/claude-test");
    });

    test("an arbitrary configured provider slug flows verbatim into the recorded model id — no id sniffing", () => {
        // A direct connection to a provider absent from any family table: `deepseek/some-alias-v2` can
        // only appear if the composition carried the CONFIGURED slug, since no derivation would ever
        // produce it from the opaque model alias.
        const callable = (async () => ({})) as unknown as ExecuteAnalysisDeps["sandboxStepCallable"];
        const authorizer = {} as unknown as RunAuthorizer;
        const deps = buildExecuteAnalysisDeps(testComposition({ sandbox: "some-alias-v2", modelProvider: "deepseek" }), callable, authorizer);

        captured = [];
        Bus.on("inflexa", spy);
        deps.emitProvenance!({ type: "step_completed", analysisId: "an-1", runId: "run-1", stepId: "step-1", status: "completed", atMs: 1_700_000_002_000 });

        const stepEvent = captured[0]!;
        if (stepEvent.type !== "prov.step_completed") throw new Error("expected prov.step_completed");
        expect(stepEvent.model).toBe("deepseek/some-alias-v2");
    });
});

// Snapshot-safety: the injected deps field must observe a live swap even when a consumer captured it
// once at registration. The fake-swap tests in
// agent_switch.test.ts prove the controller's TIMING; these prove the injection's EFFECTIVENESS through
// the REAL bundles under the worst-case consumer — one that snapshots its deps field at registration
// (exactly what destructuring `const { emitProvenance } = deps` in a consumer would do). Because the injected
// value is the holder's STABLE delegating handle, the swap lands through the captured reference.
describe("snapshot-safety — a captured deps field observes a live swap through the stable handle", () => {
    let captured: StampedEvent[] = [];
    function spy(event: StampedEvent): void {
        captured.push(event);
    }
    afterEach(() => {
        Bus.off("inflexa", spy);
    });

    const noSession = {} as unknown as AgentSession;
    const callable = (async () => ({})) as unknown as ExecuteAnalysisDeps["sandboxStepCallable"];
    const authorizer = {} as unknown as RunAuthorizer;

    test("emitProvenance captured at registration stamps the NEW name after a swap through that captured reference", () => {
        const comp = testComposition();
        const deps = buildExecuteAnalysisDeps(comp, callable, authorizer);
        // The worst case: a consumer snapshots the field ONCE, before any switch. A field mutation on a
        // consumer-held object would leave this stale; a stable delegating handle does not.
        const capturedEmit = deps.emitProvenance!;

        comp.sandboxEmitters.swap("anthropic/claude-swapped");

        captured = [];
        Bus.on("inflexa", spy);
        capturedEmit({ type: "step_completed", analysisId: "an-1", runId: "run-1", stepId: "step-1", status: "completed", atMs: 1_700_000_000_000 });

        const stepEvent = captured[0]!;
        if (stepEvent.type !== "prov.step_completed") throw new Error("expected prov.step_completed");
        expect(stepEvent.model).toBe("anthropic/claude-swapped");
    });

    test("artifactRegistry captured at registration stamps the NEW name on a command event after a swap", async () => {
        const comp = testComposition();
        const deps = buildSandboxStepDeps(comp);
        const capturedRegistry = deps.artifactRegistry;

        comp.sandboxEmitters.swap("anthropic/claude-swapped");

        captured = [];
        Bus.on("inflexa", spy);
        // A command-producing registration: the shared producer record makes the registry emit a
        // `prov.command_executed` whose `model` carries the stamped name.
        const cmdRecord = {
            outputPath: "output/r.csv",
            producer: { type: "command", command: "python3 x.py", exitCode: 0, durationMs: 1, timestamp: "t" },
            inputs: [],
            scriptPath: null,
        };
        const collector = { getRecords: () => [cmdRecord], getTrackedInputs: () => [] } as unknown as ProvenanceCollector;
        const input: ArtifactRegistrationInput = {
            resourceId: "an-1",
            runId: "run-1",
            stepId: "step-1",
            artifacts: [{ stepId: "step-1", runId: "run-1", path: "output/r.csv", size: 7, type: "output", hash: "sha256:deadbeef" }],
            collector,
        };
        await capturedRegistry.register(input, noSession);

        const cmdEvent = captured.find((e) => e.type === "prov.command_executed");
        if (cmdEvent?.type !== "prov.command_executed") throw new Error("expected prov.command_executed");
        expect(cmdEvent.model).toBe("anthropic/claude-swapped");
    });
});

describe("per-agent composition — run-engine bundles draw the sandbox agent", () => {
    test("distinct agent models: the step + execute-analysis bundles carry the SANDBOX provider + model, never the conversation agent's", () => {
        const comp = testComposition({ sandbox: "sandbox-model" });
        // The two agents are genuinely distinct here — different resolved model, different provider instance.
        expect(comp.conversation.model).not.toBe(comp.sandbox.model);
        expect(comp.conversation.provider).not.toBe(comp.sandbox.provider);

        // Every run-engine builder wires the sandbox agent's provider INSTANCE (reference equality) and model.
        const stepDeps = buildSandboxStepDeps(comp);
        expect(stepDeps.provider).toBe(comp.sandbox.provider);
        expect(stepDeps.provider).not.toBe(comp.conversation.provider);
        expect(stepDeps.model).toBe("sandbox-model");

        const callable = (async () => ({})) as unknown as ExecuteAnalysisDeps["sandboxStepCallable"];
        const authorizer = {} as unknown as RunAuthorizer;
        const execDeps = buildExecuteAnalysisDeps(comp, callable, authorizer);
        expect(execDeps.provider).toBe(comp.sandbox.provider);
        expect(execDeps.synthesisModel).toBe("sandbox-model");
    });
});

describe("buildSandboxStepDeps", () => {
    test("resolveWritePrefix is the absolute runs/{runId}/{stepId} path under the analysis's workspace root", () => {
        const deps = buildSandboxStepDeps(testComposition());
        const prefix = deps.resolveWritePrefix({ analysisId: "an-1", runId: "run-1", stepId: "step-1" } as never);

        expect(prefix).toBe("/tmp/sessions/an-1/runs/run-1/step-1");
    });

    test("buildAgent returns the catalog definition for a known agent id, wired with the step write prefix", () => {
        const comp = testComposition();
        const deps = buildSandboxStepDeps(comp);
        const writePrefix = "/tmp/sessions/an-1/runs/run-1/step-1";

        const agent = deps.buildAgent(fakeBuildContext("bulk-transcriptomics-agent", writePrefix));

        // The returned definition is the catalog's own entry for that id.
        expect(agent.id).toBe("bulk-transcriptomics-agent");
        expect(Array.isArray(agent.tools)).toBe(true);
    });

    test("buildAgent throws for an unknown agent id, naming the id and the known catalog ids", () => {
        const deps = buildSandboxStepDeps(testComposition());

        let thrown: Error | null = null;
        try {
            // The write prefix must sit under the analysis's workspace root — agent
            // construction maps it to a sandbox path — so the unknown-id lookup is
            // what fails, not the path mapping.
            deps.buildAgent(fakeBuildContext("not-a-real-agent", "/tmp/sessions/an-1/runs/run-1/step-1"));
        } catch (e) {
            thrown = e as Error;
        }

        expect(thrown).not.toBeNull();
        expect(thrown?.message).toContain("not-a-real-agent");
        // Every known catalog id is listed for the operator.
        for (const id of Object.keys(SANDBOX_AGENT_META)) {
            expect(thrown?.message).toContain(id);
        }
    });
});
