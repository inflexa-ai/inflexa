/**
 * Body-level tests for the `sandbox-step` child workflow.
 *
 *   - Seeding contract for the step's lineage collector — the one link between a
 *     step's durable input and what its provenance classifier will admit. The
 *     collector's own tests construct it directly and the parent's tests assert
 *     the projection into the child input; neither crosses the join, so the join
 *     is tested here.
 *   - The `data-step-usage` run-event part: what the step's loop spent reaches
 *     the run stream once the loop completes, under the step's stable part id,
 *     and is absent entirely when the loop reported nothing.
 *   - The host's sandbox pod labels: what the `resolvePodLabels` seam returns is
 *     what the spawn carries, and a seam that is absent or that throws still
 *     spawns the step.
 *
 * The usage tests drive `runSandboxStepBody` against a fake DBOS surface and a
 * fake deps bundle, the same shape `execute-analysis.test.ts` uses for the
 * parent.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { okAsync } from "neverthrow";
import type { Pool } from "pg";
import { CortexChatPartSchema } from "@inflexa-ai/harness/contracts/schemas/chat-parts.js";
import { isReconciling, type CortexChatPartType } from "@inflexa-ai/harness/contracts/part-registry.js";

import { makeLocalAuth } from "../auth/local-auth-context.js";
import type { RunSession } from "../auth/types.js";
import { silentLogger } from "../__tests__/setup/logger.js";
import { classifyReadPath } from "../provenance/collector.js";
import type { AgentChat, ChatResponse, ChatUsage, EmbeddingProvider } from "../providers/types.js";
import type { SandboxClient } from "../sandbox/client.js";
import type { CreateSandboxMeta, SandboxRef } from "../sandbox/types.js";
import type { ArtifactRegistry } from "../execution/artifact-registry.js";
import type { WorkspaceFilesystem } from "../workspace/filesystem.js";
import { createLineageCollector, runSandboxStepBody, type SandboxStepDeps, type SandboxStepInput } from "./sandbox-step.js";

const RUN = "run-9";

describe("createLineageCollector", () => {
    test("the step's declared dependencies reach the collector", () => {
        const collector = createLineageCollector({ stepId: "T2S2", runId: RUN, dependsOn: ["T1S1", "T1S2"] });

        expect(collector.stepId).toBe("T2S2");
        expect(collector.runId).toBe(RUN);
        expect(collector.dependsOn).toEqual(["T1S1", "T1S2"]);
    });

    test("an input predating the field fails closed to an empty declaration list", () => {
        // `dependsOn` is optional because this is durable workflow input: a
        // workflow recovered under the older shape arrives without it. Absence
        // must under-capture, never admit.
        expect(createLineageCollector({ stepId: "T2S2", runId: RUN }).dependsOn).toEqual([]);
    });

    test("the seeded declarations are what classification actually reads", () => {
        // The end of the chain the projection exists to serve: a declared
        // dependency's read is admissible and an undeclared sibling's is not,
        // decided from the collector the step input produced. Drop the seeding
        // and this is the assertion that notices.
        const collector = createLineageCollector({ stepId: "T2S2", runId: RUN, dependsOn: ["T1S1"] });

        const declared = classifyReadPath(`runs/${RUN}/T1S1/output/counts.csv`, collector.stepId, collector.runId, collector.dependsOn);
        const sibling = classifyReadPath(`runs/${RUN}/T5S1/output/scratch.csv`, collector.stepId, collector.runId, collector.dependsOn);

        expect(declared.admissible).toBe(true);
        if (!declared.admissible) throw new Error("unreachable");
        expect(declared.context).toEqual({ source: "upstream", stepId: "T1S1", runId: RUN });
        expect(sibling.admissible).toBe(false);
    });
});

// ── Fake DBOS surface ────────────────────────────────────────────────

const FAKE_CLOCK_BASE_MS = 2_000_000;
const FAKE_CLOCK_STEP_MS = 1_000;

interface FakeDbosState {
    /** Parts captured from `DBOS.writeStream("events", …)`, in emission order. */
    emittedParts: Array<Record<string, unknown>>;
    /** Monotonic fake clock (ms); `DBOS.now()` reads it then advances. */
    nowMs: number;
}

let dbosState: FakeDbosState;

/**
 * Installed by DIRECT property assignment on the DBOS class, which
 * `mock.restore()` does NOT undo — without the explicit `afterAll` restore the
 * fakes would leak into every later test file in the same bun process.
 */
let originalDbosFns: Record<string, unknown> | undefined;

async function mockDbos(): Promise<void> {
    const dbos = await import("@dbos-inc/dbos-sdk");

    originalDbosFns ??= {
        runStep: dbos.DBOS.runStep,
        writeStream: dbos.DBOS.writeStream,
        now: dbos.DBOS.now,
    };

    // Every `DBOS.runStep` runs its body inline — the body under test only needs
    // the steps to execute, not to be cached.
    (dbos.DBOS.runStep as unknown) = mock(async (fn: () => Promise<unknown>) => fn());

    (dbos.DBOS.writeStream as unknown) = mock(async (_name: string, part: unknown) => {
        dbosState.emittedParts.push(part as Record<string, unknown>);
        return undefined;
    });

    (dbos.DBOS.now as unknown) = mock(async () => {
        const t = dbosState.nowMs;
        dbosState.nowMs += FAKE_CLOCK_STEP_MS;
        return t;
    });
}

/**
 * Per-test workspace root. Hermetic on purpose: the post-step pipeline writes
 * `output/summary.md` under the step's write prefix, so a shared directory would
 * hand the NEXT run's artifact walk a file the step never produced.
 */
let workspaceRoot: string;

beforeEach(async () => {
    dbosState = { emittedParts: [], nowMs: FAKE_CLOCK_BASE_MS };
    workspaceRoot = await mkdtemp(join(tmpdir(), "cortex-sandbox-step-usage-"));
    await mockDbos();
});

afterEach(async () => {
    mock.restore();
    await rm(workspaceRoot, { recursive: true, force: true });
});

afterAll(async () => {
    if (!originalDbosFns) return;
    const dbos = await import("@dbos-inc/dbos-sdk");
    for (const [name, fn] of Object.entries(originalDbosFns)) {
        (dbos.DBOS as unknown as Record<string, unknown>)[name] = fn;
    }
});

// ── Fakes for the step's deps ────────────────────────────────────────

const ANALYSIS_ID = "an-usage";
const USAGE_RUN_ID = "run-usage";
const USAGE_STEP_ID = "T1S1";
const USAGE_AGENT_ID = "scientific-executor";
const STEP_MODEL_ID = "test-step-model";

/** A pool that answers every query with an empty rowset — no ledger assertions here. */
function makeFakePool(): Pool {
    return { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool;
}

const SANDBOX_REF: SandboxRef = {
    sandboxId: "sbx-usage",
    host: "127.0.0.1",
    port: 8765,
    backend: "docker",
    callbackSecret: "base64:unused",
};

function makeSandboxClient(spawns: CreateSandboxMeta[] = []): SandboxClient {
    return {
        createSandbox: async (meta: CreateSandboxMeta) => {
            spawns.push(meta);
            return SANDBOX_REF;
        },
        submitExec: async () => undefined,
        awaitExec: async () => {
            throw new Error("awaitExec: the usage tests run a tool-less agent");
        },
        isAlive: async () => ({ alive: true, oomKilled: false }),
        teardown: async () => undefined,
    } as unknown as SandboxClient;
}

/**
 * A chat provider that answers every call with one plain-text assistant reply
 * carrying `usage`. `finishReason: "stop"` terminates the loop on its first
 * iteration, so the run's rollup is exactly this call's usage.
 */
function makeProvider(usage: ChatUsage | undefined): AgentChat {
    const reply: ChatResponse = {
        message: { role: "assistant", content: "done" },
        finishReason: "stop",
        ...(usage ? { usage } : {}),
        requestedModelId: STEP_MODEL_ID,
    };
    return {
        capabilities: { toolCalling: true },
        chat: () => okAsync(reply),
    };
}

function makeRunSession(): RunSession {
    return {
        identity: { user: "u-1" },
        scope: { kind: "analysis", analysisId: ANALYSIS_ID },
        provenance: { agentId: "executeAnalysis", callPath: ["executeAnalysis"] },
        runFrame: { runId: USAGE_RUN_ID, stepId: USAGE_STEP_ID },
        auth: makeLocalAuth(),
    };
}

function usageStepInput(): SandboxStepInput {
    return {
        analysisId: ANALYSIS_ID,
        runId: USAGE_RUN_ID,
        stepId: USAGE_STEP_ID,
        agentId: USAGE_AGENT_ID,
        dependsOn: [],
        level: 0,
        prompt: "run the step",
        parentWorkflowId: "parent-wf",
        resources: { cpu: 2, memoryGb: 4 },
        runSession: makeRunSession(),
    };
}

/**
 * Deps for a step whose agent has no tools: the loop makes exactly one LLM call
 * and stops, and the post-step pipeline finds an empty artifact tree.
 */
function usageStepDeps(usage: ChatUsage | undefined): SandboxStepDeps {
    return {
        pool: makeFakePool(),
        logger: silentLogger,
        provider: makeProvider(usage),
        embedding: { dimensions: 3, embed: (texts) => okAsync(texts.map(() => [0, 0, 0])) } as EmbeddingProvider,
        sandboxClient: makeSandboxClient(),
        artifactRegistry: {
            register: async () => ({ registered: [], failed: [], failedCount: 0 }),
            sync: async () => undefined,
        } as ArtifactRegistry,
        workspaceFs: {} as WorkspaceFilesystem,
        resolveWorkspaceRoot: () => workspaceRoot,
        model: STEP_MODEL_ID,
        buildAgent: () => ({
            id: USAGE_AGENT_ID,
            systemPrompt: "you are a test step agent",
            model: STEP_MODEL_ID,
            tools: [],
            maxIterations: 4,
        }),
        resolveWritePrefix: (stepInput) => join(workspaceRoot, "runs", stepInput.runId, stepInput.stepId),
    };
}

/**
 * Latest-wins fold over a run's event stream, keyed by part id — the rule the
 * part registry publishes for consumers (`isReconciling`) and the one a replayed
 * emission relies on. Non-reconciling parts are appended as-is.
 */
function foldStream(parts: ReadonlyArray<Record<string, unknown>>): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    const indexById = new Map<string, number>();
    for (const part of parts) {
        const type = part.type as CortexChatPartType;
        const id = part.id as string | undefined;
        if (id === undefined || !isReconciling(type)) {
            out.push(part);
            continue;
        }
        const seen = indexById.get(id);
        if (seen === undefined) {
            indexById.set(id, out.length);
            out.push(part);
        } else {
            out[seen] = part;
        }
    }
    return out;
}

function usageParts(parts: ReadonlyArray<Record<string, unknown>>): Array<Record<string, unknown>> {
    return parts.filter((p) => p.type === "data-step-usage");
}

// ── data-step-usage emission ─────────────────────────────────────────

describe("sandbox-step data-step-usage part", () => {
    it("carries the step's rollup and the model identity it ran under when the loop completes", async () => {
        const deps = usageStepDeps({ inputTokens: 120, outputTokens: 34, cacheReadInputTokens: 100, reasoningTokens: 7 });

        const result = await runSandboxStepBody(usageStepInput(), deps);

        expect(result.status).toBe("complete");
        const emitted = usageParts(dbosState.emittedParts);
        expect(emitted.length).toBe(1);
        expect(emitted[0]).toEqual({
            type: "data-step-usage",
            id: `step-usage-${USAGE_RUN_ID}-${USAGE_STEP_ID}`,
            runId: USAGE_RUN_ID,
            stepId: USAGE_STEP_ID,
            agentId: USAGE_AGENT_ID,
            modelId: STEP_MODEL_ID,
            usage: { inputTokens: 120, outputTokens: 34, cacheReadInputTokens: 100, reasoningTokens: 7 },
        });
        // The part rides the same wire contract every other run-event part does.
        expect(CortexChatPartSchema.safeParse(emitted[0]).success).toBe(true);
    });

    it("carries the same rollup on the child's durable result, so the parent can aggregate it", async () => {
        const deps = usageStepDeps({ inputTokens: 40, outputTokens: 9 });

        const result = await runSandboxStepBody(usageStepInput(), deps);

        expect(result.usage).toEqual({ inputTokens: 40, outputTokens: 9 });
    });

    it("emits no part at all when the loop reported no usage", async () => {
        // The part's contract is to carry a step's rollup; a loop that reported
        // nothing has none, and a part naming the step with an absent usage field
        // would be a claim about a figure nobody made.
        const deps = usageStepDeps(undefined);

        const result = await runSandboxStepBody(usageStepInput(), deps);

        expect(result.status).toBe("complete");
        expect(usageParts(dbosState.emittedParts)).toEqual([]);
        expect(result.usage).toBeUndefined();
    });

    it("names its emission with the step's stable id, so one step is one part", async () => {
        // The id is a pure function of (runId, stepId) — the rule every step part
        // here follows — so re-executing the body names the same part rather than
        // inventing a second step's worth of usage.
        const input = usageStepInput();
        await runSandboxStepBody(input, usageStepDeps({ inputTokens: 120, outputTokens: 34 }));
        await runSandboxStepBody(input, usageStepDeps({ inputTokens: 120, outputTokens: 34 }));

        const emitted = usageParts(dbosState.emittedParts);
        expect(emitted.length).toBe(2);
        expect(new Set(emitted.map((p) => p.id))).toEqual(new Set([`step-usage-${USAGE_RUN_ID}-${USAGE_STEP_ID}`]));
        expect(emitted.map((p) => p.usage)).toEqual([
            { inputTokens: 120, outputTokens: 34 },
            { inputTokens: 120, outputTokens: 34 },
        ]);
    });

    it("is published as non-reconciling, like its once-per-step siblings", () => {
        // The registry entry is the contract a consumer folds by. A body-level
        // `DBOS.writeStream` is checkpointed at its function id, so a replayed body
        // appends no second row: this part reaches the stream once per step, exactly
        // as the other terminal step parts do, and claiming otherwise would tell
        // consumers to fold something that never doubles.
        expect(isReconciling("data-step-usage")).toBe(false);
        for (const sibling of ["data-step-summary", "data-step-output", "data-step-blocked"] as const) {
            expect(isReconciling(sibling)).toBe(isReconciling("data-step-usage"));
        }
    });

    it("emits one part per step id when two steps of the same run report usage", async () => {
        const first = usageStepInput();
        const second: SandboxStepInput = { ...first, stepId: "T1S2" };

        await runSandboxStepBody(first, usageStepDeps({ inputTokens: 10 }));
        await runSandboxStepBody(second, usageStepDeps({ inputTokens: 20 }));

        const folded = usageParts(foldStream(dbosState.emittedParts));
        expect(folded.map((p) => p.stepId).sort()).toEqual(["T1S1", "T1S2"]);
    });
});

// ── host-supplied sandbox pod labels ─────────────────────────────────

describe("sandbox-step pod labels", () => {
    /** Deps whose spawns are recorded, under the given `resolvePodLabels` seam. */
    function podLabelDeps(resolvePodLabels?: SandboxStepDeps["resolvePodLabels"]): { deps: SandboxStepDeps; spawns: CreateSandboxMeta[] } {
        const spawns: CreateSandboxMeta[] = [];
        const deps: SandboxStepDeps = {
            ...usageStepDeps(undefined),
            sandboxClient: makeSandboxClient(spawns),
            ...(resolvePodLabels ? { resolvePodLabels } : {}),
        };
        return { deps, spawns };
    }

    it("carries what the host resolved into the spawn, verbatim", async () => {
        const labels = { "cortex/billing-context": "bc-1", "example.com/tenant": "acme" };
        const { deps, spawns } = podLabelDeps(async () => labels);

        const result = await runSandboxStepBody(usageStepInput(), deps);

        expect(result.status).toBe("complete");
        expect(spawns.length).toBe(1);
        expect(spawns[0]!.podLabels).toEqual(labels);
    });

    it("resolves under the step's own session, so the labels name the step that spawns", async () => {
        const seen: RunSession[] = [];
        const { deps } = podLabelDeps(async (session) => {
            seen.push(session);
            return {};
        });

        await runSandboxStepBody(usageStepInput(), deps);

        expect(seen.length).toBe(1);
        expect(seen[0]!.provenance.agentId).toBe(USAGE_AGENT_ID);
        expect(seen[0]!.runFrame).toEqual({ runId: USAGE_RUN_ID, stepId: USAGE_STEP_ID });
    });

    it("spawns with no labels and completes when no seam is wired", async () => {
        const { deps, spawns } = podLabelDeps();

        const result = await runSandboxStepBody(usageStepInput(), deps);

        expect(result.status).toBe("complete");
        expect(spawns[0]!.podLabels).toBeUndefined();
    });

    it("spawns with no labels and completes when the seam throws", async () => {
        // Attribution is never a gate on compute: the step runs unlabeled.
        const { deps, spawns } = podLabelDeps(async () => {
            throw new Error("upstream unreachable");
        });

        const result = await runSandboxStepBody(usageStepInput(), deps);

        expect(result.status).toBe("complete");
        expect(spawns[0]!.podLabels).toBeUndefined();
    });
});
