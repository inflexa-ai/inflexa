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
    type ExecuteAnalysisDeps,
    type ProvenanceCollector,
    type RunAuthorizer,
    type SandboxAgentBuildContext,
} from "@inflexa-ai/harness";

import { Bus } from "../../lib/bus.ts";
import type { StampedEvent } from "../../types/events.ts";
import { buildExecuteAnalysisDeps, buildSandboxStepDeps, type RunEngineComposition } from "./run_deps.ts";

// All factories below construct lazily (pg pools connect on first query; the
// SDK clients open no socket at construction), so the whole module builds
// offline — no Postgres, proxy, embeddings endpoint, or Docker daemon.
function testComposition(): RunEngineComposition {
    const resolveBilling = createNoopBillingResolver();
    const pool = createPool({ host: "localhost", port: "5", database: "d", user: "u", password: "p", sslMode: "disable" });
    // A `<base>/<analysisId>` resolver keeps the byte layout the old fixed base
    // produced, so every expected path below stays literal and readable.
    const resolveWorkspaceRoot = (analysisId: string): string => join("/tmp/sessions", analysisId);
    return {
        pool,
        provider: createAnthropicProvider({ baseURL: "http://proxy.test", token: "t", model: "claude-test", resolveBilling }),
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
        modelRef: { provider: "anthropic", model: "claude-test" },
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

        // The emitter closed over the composition's model ref — a settled step records which model
        // drove it (the wiring half of the model-agent record; the mapping itself is prov_bridge's).
        deps.emitProvenance!({ type: "step_completed", analysisId: "an-1", runId: "run-1", stepId: "step-1", status: "completed", atMs: 1_700_000_001_000 });
        const stepEvent = captured[1]!;
        if (stepEvent.type !== "prov.step_completed") throw new Error("expected prov.step_completed");
        expect(stepEvent.model).toEqual({ provider: "anthropic", model: "claude-test" });
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
