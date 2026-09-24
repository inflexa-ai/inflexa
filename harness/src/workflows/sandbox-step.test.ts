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
 *   - The spawn of the step sandbox: the client gets the step session, thus the
 *     sandbox takes its ids from it and the label hook of the client sees it.
 *
 * The usage tests drive `runSandboxStepBody` against a fake DBOS surface and a
 * fake deps bundle, the same shape `execute-analysis.test.ts` uses for the
 * parent.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResultPart } from "ai";
import { errAsync, ok, okAsync } from "neverthrow";
import { Error as DBOSErrors } from "@dbos-inc/dbos-sdk";
import type { Pool } from "pg";
import { z } from "zod";
import { CortexChatPartSchema } from "@inflexa-ai/harness/contracts/schemas/chat-parts.js";
import { isReconciling, type CortexChatPartType } from "@inflexa-ai/harness/contracts/part-registry.js";

import { makeLocalAuth } from "../auth/local-auth-context.js";
import type { RunSession, SpawnSession } from "../auth/types.js";
import { createCapturingLogger, silentLogger, type CapturingLogger } from "../__tests__/setup/logger.js";
import { classifyReadPath } from "../provenance/collector.js";
import type { AgentChat, ChatRequest, ChatResponse, ChatUsage, EmbeddingProvider } from "../providers/types.js";
import type { SandboxClient } from "../sandbox/client.js";
import type { SandboxRef, SandboxSpec } from "../sandbox/types.js";
import type { ArtifactRegistry, ArtifactSyncInput } from "../execution/artifact-registry.js";
import type { GateFailure } from "../lib/hooks.js";
import type { WorkspaceFilesystem } from "../workspace/filesystem.js";
import { makeMessage, scriptedProvider, textBlock, toolUseBlock } from "../loop/__fixtures__/scripted-provider.js";
import type { AgentDefinition } from "../loop/types.js";
import { defineTool, type Tool } from "../tools/define-tool.js";
import { createSubmitFileMetadataTool, type FileMetadataCell } from "../tools/sandbox/submit-file-metadata.js";
import { CAPPED_OUT_EMPTY_REASON, createLineageCollector, runSandboxStepBody, type SandboxStepDeps, type SandboxStepInput } from "./sandbox-step.js";

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
    /** Messages captured from `DBOS.send`, in send order. */
    sent: Array<{ destination: string; message: unknown; topic: string | undefined }>;
    /** Workflow ids captured from `DBOS.cancelWorkflow`. */
    cancelled: Array<string | undefined>;
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
        send: dbos.DBOS.send,
        cancelWorkflow: dbos.DBOS.cancelWorkflow,
    };

    // Every `DBOS.runStep` runs its body inline — the body under test only needs
    // the steps to execute, not to be cached. The self-cancel of a suspension
    // raises the cancellation at its step, as the real engine does.
    (dbos.DBOS.runStep as unknown) = mock(async (fn: () => Promise<unknown>, config?: { name?: string }) => {
        if (config?.name === "self-cancel-suspended") throw new DBOSErrors.DBOSWorkflowCancelledError("child");
        return fn();
    });

    (dbos.DBOS.send as unknown) = mock(async (destination: string, message: unknown, topic?: string) => {
        dbosState.sent.push({ destination, message, topic });
    });

    (dbos.DBOS.cancelWorkflow as unknown) = mock(async (workflowId: string | undefined) => {
        dbosState.cancelled.push(workflowId);
    });

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
    dbosState = { emittedParts: [], nowMs: FAKE_CLOCK_BASE_MS, sent: [], cancelled: [] };
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

function makeSandboxClient(spawns: Array<{ session: SpawnSession; spec: SandboxSpec }> = []): SandboxClient {
    return {
        createSandbox: (session: SpawnSession, spec: SandboxSpec) => {
            spawns.push({ session, spec });
            return okAsync(SANDBOX_REF);
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
 * The step agent of the rigs: the given tools, then the output tool of the
 * file-metadata continuation, bound to the cell of the step, as the substrate
 * of a real step agent declares it.
 */
function stepAgent(fileMetadata: FileMetadataCell, tools: readonly Tool[] = [], maxIterations = 4): AgentDefinition {
    return {
        id: USAGE_AGENT_ID,
        systemPrompt: "you are a test step agent",
        model: STEP_MODEL_ID,
        tools: [...tools, createSubmitFileMetadataTool(fileMetadata)],
        maxIterations,
    };
}

/**
 * Deps for a step whose agent declares only the output tool: the loop makes
 * exactly one LLM call and stops, and the post-step pipeline finds an empty
 * artifact tree.
 */
function usageStepDeps(usage: ChatUsage | undefined): SandboxStepDeps {
    return {
        pool: makeFakePool(),
        logger: silentLogger,
        provider: makeProvider(usage),
        embedding: { dimensions: 3, embed: (texts) => okAsync(texts.map(() => [0, 0, 0])) } as EmbeddingProvider,
        sandboxClient: makeSandboxClient(),
        artifactRegistry: {
            register: () => okAsync({ registered: [], failed: [], failedCount: 0 }),
            sync: () => okAsync(undefined),
        } as ArtifactRegistry,
        workspaceFs: {} as WorkspaceFilesystem,
        resolveWorkspaceRoot: () => workspaceRoot,
        model: STEP_MODEL_ID,
        buildAgent: ({ fileMetadata }) => stepAgent(fileMetadata),
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

// ── the output tool of the file-metadata continuation ───────────────

/** The tool result of one call in the messages of a request. */
function toolResultIn(request: ChatRequest, toolCallId: string): ToolResultPart | undefined {
    return request.messages
        .flatMap((message) => (message.role === "tool" ? message.content : []))
        .find((part): part is ToolResultPart => part.type === "tool-result" && part.toolCallId === toolCallId);
}

describe("sandbox-step file-metadata output tool", () => {
    it("masks submit_file_metadata during the task, thus the call gets the error of the mask", async () => {
        let cell: FileMetadataCell | undefined;
        const provider = scriptedProvider((i) =>
            i === 0
                ? makeMessage(
                      [
                          toolUseBlock("tu-meta", "submit_file_metadata", {
                              files: [{ path: "output/result.csv", description: "counts", dataType: "table", format: "csv" }],
                          }),
                      ],
                      "tool_use",
                  )
                : makeMessage([textBlock("done")], "end_turn"),
        );
        const deps: SandboxStepDeps = {
            ...usageStepDeps(undefined),
            provider,
            buildAgent: ({ fileMetadata }) => {
                cell = fileMetadata;
                return stepAgent(fileMetadata);
            },
        };

        const result = await runSandboxStepBody(usageStepInput(), deps);

        expect(result.status).toBe("complete");
        const refusal = toolResultIn(provider.calls[1]!, "tu-meta");
        expect(refusal?.output.type).toBe("error-text");
        expect(JSON.stringify(refusal?.output)).toContain("The tool submit_file_metadata is not available for this request");
        expect(cell?.descriptions.size).toBe(0);
    });
});

// ── the post-step continuations of the step agent ───────────────────

describe("sandbox-step post-step continuations", () => {
    /** A real file under the step's write prefix, thus the manifest is not empty and the metadata stage runs. */
    async function seedStepOutput(): Promise<void> {
        const dir = join(workspaceRoot, "runs", USAGE_RUN_ID, USAGE_STEP_ID, "output");
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "result.csv"), "gene,count\nTP53,7\n");
    }

    function outputFiles(): unknown {
        return dbosState.emittedParts.find((part) => part.type === "data-step-output")?.files;
    }

    it("gives the summary the messages of the metadata exchange after the transcript of the task", async () => {
        await seedStepOutput();
        const submit = makeMessage(
            [
                toolUseBlock("m1", "submit_file_metadata", {
                    files: [{ path: "output/result.csv", description: "gene counts", dataType: "count matrix", format: "csv" }],
                }),
            ],
            "tool_use",
        );
        const described = makeMessage([textBlock("described")], "end_turn");
        // The task, the two requests of the metadata exchange, then the summary.
        const replies = [makeMessage([textBlock("done")], "end_turn"), submit, described, makeMessage([textBlock("## Summary")], "end_turn")];
        const provider = scriptedProvider((i) => replies[i]!);

        const result = await runSandboxStepBody(usageStepInput(), { ...usageStepDeps(undefined), provider });

        expect(result.status).toBe("complete");
        expect(provider.calls).toHaveLength(4);
        const metadataRequest = provider.calls[1]!;
        const summaryRequest = provider.calls[3]!;
        // [briefing, assistant(done), metadata request, assistant(submit), tool(result), assistant(described), summary request]
        expect(summaryRequest.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "tool", "assistant", "user"]);
        expect(JSON.stringify(summaryRequest.messages.slice(0, 2))).toBe(JSON.stringify(metadataRequest.messages.slice(0, 2)));
        expect(summaryRequest.messages[2]!.content).toBe(metadataRequest.messages[2]!.content);
        expect(summaryRequest.messages[3]).toEqual(submit.message);
        expect(summaryRequest.messages[5]).toEqual(described.message);
        expect(outputFiles()).toEqual([expect.objectContaining({ path: "output/result.csv", description: "gene counts" })]);
    });

    it("reads a cached metadata array of an earlier version as entries, and the summary continues the transcript directly", async () => {
        await seedStepOutput();
        const dbos = await import("@dbos-inc/dbos-sdk");
        const runInline = dbos.DBOS.runStep as unknown as (fn: () => Promise<unknown>, config?: { name?: string }) => Promise<unknown>;
        const cached = [{ dbPath: `runs/${USAGE_RUN_ID}/${USAGE_STEP_ID}/output/result.csv`, description: "cached description", metadata: { format: "csv" } }];
        // The checkpoint of the earlier version: a bare array of entries, which the replay returns with no call.
        (dbos.DBOS.runStep as unknown) = mock(async (fn: () => Promise<unknown>, config?: { name?: string }) =>
            config?.name === "post-step.generate-file-metadata" ? cached : runInline(fn, config),
        );
        const replies = [makeMessage([textBlock("done")], "end_turn"), makeMessage([textBlock("## Summary")], "end_turn")];
        const provider = scriptedProvider((i) => replies[i]!);

        const result = await runSandboxStepBody(usageStepInput(), { ...usageStepDeps(undefined), provider });

        expect(result.status).toBe("complete");
        // The task and the summary only. The summary request follows the transcript directly.
        expect(provider.calls).toHaveLength(2);
        expect(provider.calls[1]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
        expect(outputFiles()).toEqual([expect.objectContaining({ path: "output/result.csv", description: "cached description" })]);
    });
});

// ── the spawn of the step sandbox ───────────────────────────────────

describe("sandbox-step spawn", () => {
    it("spawns under the step session, thus the sandbox takes the ids of the step from it", async () => {
        const spawns: Array<{ session: SpawnSession; spec: SandboxSpec }> = [];
        const deps: SandboxStepDeps = { ...usageStepDeps(undefined), sandboxClient: makeSandboxClient(spawns) };

        const result = await runSandboxStepBody(usageStepInput(), deps);

        expect(result.status).toBe("complete");
        expect(spawns).toHaveLength(1);
        expect(spawns[0]!.session.runFrame).toEqual({ runId: USAGE_RUN_ID, stepId: USAGE_STEP_ID });
        expect(spawns[0]!.session.scope.analysisId).toBe(ANALYSIS_ID);
        expect(spawns[0]!.session.provenance.agentId).toBe(USAGE_AGENT_ID);
        expect(Object.keys(spawns[0]!.spec).sort()).toEqual(["childWorkflowId", "extraEnv", "image", "resources"]);
    });
});

// ── suspension ────────────────────────────────────────────────────────

describe("sandbox-step suspension", () => {
    function statementPool(): { pool: Pool; statements: Array<{ text: string; values: readonly unknown[] }> } {
        const statements: Array<{ text: string; values: readonly unknown[] }> = [];
        const pool = {
            query: async (arg: unknown, params?: unknown[]) => {
                const text = typeof arg === "string" ? arg : ((arg as { text?: string }).text ?? "");
                const values = typeof arg === "object" && arg !== null && "values" in arg ? ((arg as { values?: unknown[] }).values ?? []) : (params ?? []);
                statements.push({ text, values });
                return { rows: [], rowCount: 0 };
            },
        } as unknown as Pool;
        return { pool, statements };
    }

    const CHILD_ID = `${USAGE_RUN_ID}-${USAGE_STEP_ID}`;

    function expectSuspended(statements: Array<{ text: string; values: readonly unknown[] }>, reason: string): void {
        const marked = statements.filter((q) => /UPDATE\s+cortex_step_executions/i.test(q.text) && q.values.includes("canceled"));
        expect(marked).toHaveLength(1);
        // The error and the last error class of the row both carry the reason of the host.
        expect(marked[0]!.values.filter((v) => v === reason)).toHaveLength(2);
        expect(dbosState.sent).toEqual([
            { destination: "parent-wf", message: { kind: "suspended", childWorkflowId: CHILD_ID, stepId: USAGE_STEP_ID, reason }, topic: "child-suspended" },
        ]);
        expect(dbosState.cancelled).toHaveLength(1);
    }

    it("a suspend error of the model marks the row with the reason, sends the typed suspension, and self-cancels", async () => {
        const { pool, statements } = statementPool();
        const deps: SandboxStepDeps = {
            ...usageStepDeps(undefined),
            pool,
            provider: {
                capabilities: { toolCalling: true },
                chat: () =>
                    errAsync({ type: "suspend", retryable: false, reason: "payment_required", status: 402, message: "Provider call failed (HTTP 402)" }),
            },
        };

        await expect(runSandboxStepBody(usageStepInput(), deps)).rejects.toBeInstanceOf(DBOSErrors.DBOSWorkflowCancelledError);

        expectSuspended(statements, "payment_required");
    });

    it("a refused spawn with the suspend flag suspends the step before any sandbox exists", async () => {
        const { pool, statements } = statementPool();
        const teardowns: string[] = [];
        const refusing = {
            ...makeSandboxClient(),
            createSandbox: () => errAsync({ type: "labels_refused" as const, op: "createSandbox", reason: "account_frozen", suspend: true }),
            teardown: async (ref: SandboxRef) => {
                teardowns.push(ref.sandboxId);
            },
        } as unknown as SandboxClient;

        await expect(runSandboxStepBody(usageStepInput(), { ...usageStepDeps(undefined), pool, sandboxClient: refusing })).rejects.toBeInstanceOf(
            DBOSErrors.DBOSWorkflowCancelledError,
        );

        expectSuspended(statements, "account_frozen");
        expect(teardowns).toEqual([]);
    });

    it("a refused spawn without the suspend flag fails the step and sends no suspension", async () => {
        const refusing = {
            ...makeSandboxClient(),
            createSandbox: () => errAsync({ type: "labels_refused" as const, op: "createSandbox", reason: "labels_unavailable", suspend: false }),
        } as unknown as SandboxClient;

        await expect(runSandboxStepBody(usageStepInput(), { ...usageStepDeps(undefined), sandboxClient: refusing })).rejects.toThrow("labels_unavailable");

        expect(dbosState.sent).toEqual([]);
        expect(dbosState.cancelled).toEqual([]);
    });
});

// ── lineage attestation: registration and byte-sync ──────────────────

/**
 * The two operations behind `data-step-activity: persisting`. Registration
 * assigns each artifact its external id; the sync uploads the bytes those ids
 * point at. They are sequenced independently in the body because a rejected
 * registration that skipped the sync leaves the rows that DID register with an
 * `artifact_id` and no `file_id` — an orphan the step's own fail-fast exists to
 * prevent.
 */
describe("sandbox-step lineage attestation", () => {
    const REGISTRY_REJECTION = "provenance registry rejected the payload";
    const SYNC_FAILURE = "artifact store reachability lost";
    /** The generic phrase `failStep` scrubs a lineage failure down to. */
    const SCRUBBED = "Step results could not be finalized.";

    /**
     * A real file under the step's write prefix, so the artifact walk yields a
     * non-empty manifest and registration is actually reached — an empty manifest
     * short-circuits before the registry is ever called.
     */
    async function seedStepOutput(): Promise<void> {
        const dir = join(workspaceRoot, "runs", USAGE_RUN_ID, USAGE_STEP_ID, "output");
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "result.csv"), "gene,count\nTP53,7\n");
    }

    interface AttestationProbe {
        readonly deps: SandboxStepDeps;
        /** Every `sync` call, in order. */
        readonly syncCalls: ArtifactSyncInput[];
        /** `"register"` / `"sync"` in invocation order. */
        readonly order: string[];
    }

    function attestationDeps(args: {
        logger?: SandboxStepDeps["logger"];
        rejectRegistration: boolean;
        syncFails: boolean;
        refuseRegistration?: GateFailure;
    }): AttestationProbe {
        const syncCalls: ArtifactSyncInput[] = [];
        const order: string[] = [];
        const artifactRegistry: ArtifactRegistry = {
            register: (registration) => {
                order.push("register");
                if (args.refuseRegistration) return errAsync(args.refuseRegistration);
                if (!args.rejectRegistration) return okAsync({ registered: [], failed: [], failedCount: 0 });
                return okAsync({
                    registered: [],
                    failed: [{ path: `runs/${registration.runId}/${registration.stepId}/output/result.csv`, error: REGISTRY_REJECTION }],
                    failedCount: 1,
                });
            },
            sync: (syncInput) => {
                order.push("sync");
                syncCalls.push(syncInput);
                return args.syncFails ? errAsync({ reason: SYNC_FAILURE }) : okAsync(undefined);
            },
        };
        return {
            deps: { ...usageStepDeps(undefined), ...(args.logger ? { logger: args.logger } : {}), artifactRegistry },
            syncCalls,
            order,
        };
    }

    const SYNC_INPUT: ArtifactSyncInput = { resourceId: ANALYSIS_ID, runId: USAGE_RUN_ID, stepId: USAGE_STEP_ID };

    /** The `step failure` record — the only account of why a scrubbed step died. */
    function stepFailure(logger: CapturingLogger): { errorClass: unknown; err: string } | undefined {
        const rec = logger.records.find((r) => r.msg.endsWith("step failure"));
        return rec ? { errorClass: rec.fields.errorClass, err: String(rec.fields.err) } : undefined;
    }

    it("uploads the bytes even when registration is rejected", async () => {
        // The regression this guards: a rejected registration used to abort the
        // block before the sync, stranding every row that DID register with an
        // `artifact_id` and a NULL `file_id`.
        await seedStepOutput();
        const { deps, syncCalls, order } = attestationDeps({ rejectRegistration: true, syncFails: false });

        await expect(runSandboxStepBody(usageStepInput(), deps)).rejects.toThrow(SCRUBBED);

        expect(syncCalls).toEqual([SYNC_INPUT]);
        expect(order).toEqual(["register", "sync"]);
    });

    it("records the registration rejection as the cause, not the sync failure that followed it", async () => {
        // The sync attempt must not be able to displace the error that actually
        // failed the step — the thrown message is scrubbed, so this record is the
        // only thing an operator can diagnose from.
        await seedStepOutput();
        const logger = createCapturingLogger();
        const { deps, syncCalls } = attestationDeps({ logger, rejectRegistration: true, syncFails: true });

        await expect(runSandboxStepBody(usageStepInput(), deps)).rejects.toThrow(SCRUBBED);

        expect(syncCalls).toEqual([SYNC_INPUT]);
        const failure = stepFailure(logger);
        expect(failure?.errorClass).toBe("lineage_attestation");
        expect(failure?.err).toContain(REGISTRY_REJECTION);
        expect(failure?.err).not.toContain(SYNC_FAILURE);

        // The sync is a notice: its failure is logged at the error level, under its own stage name.
        const syncFailure = logger.records.find((r) => r.fields.notice === "ArtifactRegistry.sync");
        expect(syncFailure?.level).toBe("error");
        expect(syncFailure?.msg).toContain("post-step.sync");
        expect(syncFailure?.fields.reason).toBe(SYNC_FAILURE);
    });

    it("fails the step with the reason of the host when the register gate refuses, and still syncs", async () => {
        await seedStepOutput();
        const logger = createCapturingLogger();
        const { deps, syncCalls, order } = attestationDeps({
            logger,
            rejectRegistration: false,
            syncFails: false,
            refuseRegistration: { reason: "ledger refused", suspend: false },
        });

        await expect(runSandboxStepBody(usageStepInput(), deps)).rejects.toThrow(SCRUBBED);

        expect(order).toEqual(["register", "sync"]);
        expect(syncCalls).toEqual([SYNC_INPUT]);
        const failure = stepFailure(logger);
        expect(failure?.errorClass).toBe("lineage_attestation");
        expect(failure?.err).toContain("ledger refused");
    });

    it("registers then syncs once and completes when both succeed", async () => {
        await seedStepOutput();
        const { deps, syncCalls, order } = attestationDeps({ rejectRegistration: false, syncFails: false });

        const result = await runSandboxStepBody(usageStepInput(), deps);

        expect(result.status).toBe("complete");
        expect(order).toEqual(["register", "sync"]);
        expect(syncCalls).toEqual([SYNC_INPUT]);
    });

    it("completes the step when registration succeeds and the sync gives an err, and logs the reason", async () => {
        // The sync is a notice: the rows stay unsynced, and a later sync of the
        // step selects them again, thus the step does not fail over it.
        await seedStepOutput();
        const logger = createCapturingLogger();
        const { deps, syncCalls } = attestationDeps({ logger, rejectRegistration: false, syncFails: true });

        const result = await runSandboxStepBody(usageStepInput(), deps);

        expect(result.status).toBe("complete");
        expect(syncCalls).toEqual([SYNC_INPUT]);
        expect(stepFailure(logger)).toBeUndefined();
        const syncFailure = logger.records.find((r) => r.fields.notice === "ArtifactRegistry.sync");
        expect(syncFailure?.level).toBe("error");
        expect(syncFailure?.fields.reason).toBe(SYNC_FAILURE);
    });
});

// ── capped-out steps with no deliverables route to blocked ───────────

/**
 * The narrow rule (see the harness-sandbox-agents spec): a loop that spent its
 * whole iteration budget and persisted nothing terminates `blocked` with a
 * deterministic reason, so its dependents never run against an empty manifest.
 * A blocker outcome keeps its own reason, a capped-out step with artifacts
 * stays `completed`, and a clean empty finish stays `completed`.
 */
describe("sandbox-step capped-out empty manifest", () => {
    /**
     * A pool that records every query's bind values, so the ledger write is
     * assertable. `updateStepExecution` calls `query({ text, values })` (the
     * config form) while other writers use `query(text, params)` — record both.
     */
    function makeRecordingPool(): { pool: Pool; values: unknown[] } {
        const values: unknown[] = [];
        const pool = {
            query: async (arg: unknown, params?: unknown[]) => {
                if (typeof arg === "object" && arg !== null && "values" in arg) {
                    values.push(...((arg as { values?: unknown[] }).values ?? []));
                }
                values.push(...(params ?? []));
                return { rows: [], rowCount: 0 };
            },
        } as unknown as Pool;
        return { pool, values };
    }

    /**
     * Deps whose loop caps out: a one-iteration agent with one `echo` tool, and
     * a provider whose first reply is a tool call. The wrap-up call (and every
     * post-step producer call after it) gets a plain "done", so the loop ends
     * with `finish.cappedOut: true` and `reason: "max_iterations"`.
     */
    function cappedOutDeps(args: { blockerReason?: string } = {}): { deps: SandboxStepDeps; values: unknown[] } {
        const { pool, values } = makeRecordingPool();
        const provider = scriptedProvider((i) =>
            i === 0 ? makeMessage([toolUseBlock("tu-1", "echo", { label: "x" })], "tool_use") : makeMessage([textBlock("done")], "end_turn"),
        );
        const deps: SandboxStepDeps = {
            ...usageStepDeps(undefined),
            pool,
            provider,
            buildAgent: ({ blockerHolder, fileMetadata }) =>
                stepAgent(
                    fileMetadata,
                    [
                        defineTool({
                            id: "echo",
                            description: "Echo the label back.",
                            inputSchema: z.object({ label: z.string() }),
                            describeCall: "none",
                            execute: async ({ label }) => {
                                if (args.blockerReason !== undefined) {
                                    blockerHolder.outcome = { kind: "blocker", reason: args.blockerReason };
                                }
                                return ok({ label });
                            },
                        }),
                    ],
                    1,
                ),
        };
        return { deps, values };
    }

    function blockedParts(parts: ReadonlyArray<Record<string, unknown>>): Array<Record<string, unknown>> {
        return parts.filter((p) => p.type === "data-step-blocked");
    }

    it("terminates blocked with the deterministic reason when the cap hits an empty manifest", async () => {
        const { deps, values } = cappedOutDeps();

        const result = await runSandboxStepBody(usageStepInput(), deps);

        expect(result.status).toBe("blocked");
        expect(result.error).toBe(CAPPED_OUT_EMPTY_REASON);
        expect(result.finishReason).toBe("max_iterations");
        // The ledger write carries the reason (error + blocked_reason) and the cap.
        expect(values).toContain("blocked");
        expect(values.filter((v) => v === CAPPED_OUT_EMPTY_REASON).length).toBe(2);
        const emitted = blockedParts(dbosState.emittedParts);
        expect(emitted.length).toBe(1);
        expect(emitted[0]!.reason).toBe(CAPPED_OUT_EMPTY_REASON);
    });

    it("stays completed when the capped-out step persisted artifacts", async () => {
        const dir = join(workspaceRoot, "runs", USAGE_RUN_ID, USAGE_STEP_ID, "output");
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "result.csv"), "gene,count\nTP53,7\n");
        const { deps, values } = cappedOutDeps();

        const result = await runSandboxStepBody(usageStepInput(), deps);

        expect(result.status).toBe("complete");
        expect(result.finishReason).toBe("max_iterations");
        expect(values).toContain("completed");
        // hit_max_steps binds as 1 on the mark-complete write.
        expect(values).toContain(1);
        expect(blockedParts(dbosState.emittedParts)).toEqual([]);
    });

    it("stays completed on a clean empty finish under the cap", async () => {
        // The pre-existing contract: no files, no blocker, and a stop before the
        // cap is a legitimately-empty step, and no artifact-count inference runs.
        const { pool, values } = makeRecordingPool();
        const deps: SandboxStepDeps = { ...usageStepDeps(undefined), pool };

        const result = await runSandboxStepBody(usageStepInput(), deps);

        expect(result.status).toBe("complete");
        expect(values).toContain("completed");
        expect(blockedParts(dbosState.emittedParts)).toEqual([]);
    });

    it("keeps the blocker's own reason when the step also capped out", async () => {
        const { deps } = cappedOutDeps({ blockerReason: "the input has no batch column" });

        const result = await runSandboxStepBody(usageStepInput(), deps);

        expect(result.status).toBe("blocked");
        expect(result.error).toBe("the input has no batch column");
        const emitted = blockedParts(dbosState.emittedParts);
        expect(emitted.length).toBe(1);
        expect(emitted[0]!.reason).toBe("the input has no batch column");
    });
});
