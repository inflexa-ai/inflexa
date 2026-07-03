import { describe, expect, test } from "bun:test";
import {
    createAnthropicProvider,
    createEmbeddingProvider,
    createNoopBillingResolver,
    createPool,
    createSandboxClient,
    createWorkspaceFilesystem,
    SANDBOX_AGENT_META,
    type SandboxAgentBuildContext,
} from "@inflexa-ai/harness";

import { buildSandboxStepDeps, createStubArtifactRegistry, type RunEngineComposition } from "./run_deps.ts";

// All factories below construct lazily (pg pools connect on first query; the
// SDK clients open no socket at construction), so the whole module builds
// offline — no Postgres, proxy, embeddings endpoint, or Docker daemon.
function testComposition(): RunEngineComposition {
    const resolveBilling = createNoopBillingResolver();
    const pool = createPool({ host: "localhost", port: "5", database: "d", user: "u", password: "p", sslMode: "disable" });
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
            sessionsBasePath: "/tmp/sessions",
        }),
        workspaceFs: createWorkspaceFilesystem({ sessionsBasePath: "/tmp/sessions" }),
        sessionsBasePath: "/tmp/sessions",
        model: "claude-test",
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

describe("createStubArtifactRegistry", () => {
    test("register reports zero registrations and zero failures", async () => {
        const registry = createStubArtifactRegistry();
        // Inputs are unread by the no-op; empty casts stand in for the harness's
        // registration input + session the cli cannot construct barrel-only.
        const result = await registry.register({} as never, {} as never);

        expect(result).toEqual({ registered: [], failed: [], failedCount: 0 });
    });

    test("sync resolves to void", async () => {
        const registry = createStubArtifactRegistry();
        await expect(registry.sync({} as never, {} as never)).resolves.toBeUndefined();
    });
});

describe("buildSandboxStepDeps", () => {
    test("resolveWritePrefix is the absolute runs/{runId}/{stepId} path under the session tree", () => {
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
            deps.buildAgent(fakeBuildContext("not-a-real-agent", "/tmp/prefix"));
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
