// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the ISO instant shape of a recorded activity timestamp
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T.*Z$/;

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

import { textOf } from "../../lib/unknown-text.js";
import { afterAll, afterEach, beforeEach, describe, expect, it, mock, test } from "bun:test";
import { PAUSE_CLEAR_WRITE, PAUSE_RECORD_WRITE, STEP_EXECUTIONS_UPDATE } from "./sql-writes.js";
import { referencedToolOutput } from "../../lib/test/text-shapes.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APICallError, type LanguageModelV4CallOptions, type LanguageModelV4Prompt, type LanguageModelV4ToolResultPart } from "@ai-sdk/provider";
import { errAsync, ok, okAsync } from "neverthrow";
import { z } from "zod";
import { parseUnknownRecord } from "../../lib/unknown-containers.js";
import { ChatPartSchema } from "@inflexa-ai/harness/contracts/schemas/chat-parts.js";
import { isKnownPartType, isReconciling } from "@inflexa-ai/harness/contracts/part-registry.js";

import { makeFakeWorkspaceFs } from "../../agents/sandbox/__fixtures__/deps.js";
import { makeLocalAuth } from "../../auth/local-auth-context.js";
import { createLocalRunAuthorizer } from "../../auth/local-run-authorizer.js";
import { unusedCitationResolver } from "../../citations/__fixtures__/resolver.js";
import type { SpawnSession } from "../../auth/types.js";
import { createCapturingLogger, silentLogger, type CapturingLogger } from "../../__tests__/setup/logger.js";
import { classifyReadPath } from "../../provenance/collector.js";
import type { ChatProvider, ChatUsage } from "../../providers/types.js";
import type { SandboxClient } from "../../sandbox/client.js";
import { fakeLeases, leaseOverClient } from "../../sandbox/__fixtures__/leases.js";
import type { Querier } from "../../state/db.js";
import type { SandboxRef, SandboxSpec } from "../../sandbox/types.js";
import type { ArtifactRegistry, ArtifactSyncInput } from "../../execution/artifact-registry.js";
import type { GateFailure } from "../../lib/hooks.js";
import { callTools, reply, scriptedModel, text, toolCall } from "../../testing.js";
import type { KeptToolOutput, ToolOutputStore } from "../../loop/tool-output.js";
import type { AgentDefinition } from "../../loop/types.js";
import { defineTool, type Tool } from "../../tools/define-tool.js";
import { createReadToolOutputTool } from "../../tools/read-tool-output.js";
import { createExecuteCommandTool } from "../../tools/workspace/execute-command.js";
import { createReportBlockerTool } from "../../tools/sandbox/report-blocker.js";
import { createSubmitFileMetadataTool, type FileMetadataCell } from "../../tools/sandbox/submit-file-metadata.js";
import { CAPPED_OUT_EMPTY_REASON, createLineageCollector, runSandboxStepBody, type SandboxStepDeps, type SandboxStepInput } from "../sandbox-step.js";
import { RESUME_MESSAGE } from "../pause.js";
import { presentAt, presentLast } from "../../lib/present.js";

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

type FakeDbosState = {
    /** Parts captured from `DBOS.writeStream("events", …)`, in emission order. */
    emittedParts: Array<Record<string, unknown>>;
    /** Monotonic fake clock (ms); `DBOS.now()` reads it then advances. */
    nowMs: number;
    /** Messages captured from `DBOS.send`, in send order. */
    sent: Array<{ destination: string; message: unknown; topic: string | undefined }>;
    /** Workflow ids captured from `DBOS.cancelWorkflow`. */
    cancelled: Array<string | undefined>;
    /** The topic of each `DBOS.recv`, in call order. Each one is a wait of a pause, and the fake gives the resume message. */
    recvTopics: string[];
    /** Runs at each `DBOS.recv`, before the fake gives the resume message: a test reads the state of the wait. */
    onRecv: (() => void) | undefined;
    /** The count of `DBOS.randomUUID` calls; the fake gives `uuid-<count>`. */
    uuidCounter: number;
};

let dbosState: FakeDbosState;

/**
 * Installed by DIRECT property assignment on the DBOS class, which
 * `mock.restore()` does NOT undo — without the explicit `afterAll` restore the
 * fakes would leak into every later test file in the same bun process.
 */
let originalDbosFns: Record<string, unknown> | undefined;
let originalWorkflowId: PropertyDescriptor | undefined;

async function mockDbos(): Promise<void> {
    const dbos = await import("@dbos-inc/dbos-sdk");

    originalDbosFns ??= {
        runStep: dbos.DBOS.runStep.bind(dbos.DBOS),
        writeStream: dbos.DBOS.writeStream.bind(dbos.DBOS),
        now: dbos.DBOS.now.bind(dbos.DBOS),
        send: dbos.DBOS.send.bind(dbos.DBOS),
        cancelWorkflow: dbos.DBOS.cancelWorkflow.bind(dbos.DBOS),
        isInWorkflow: dbos.DBOS.isInWorkflow.bind(dbos.DBOS),
        recv: dbos.DBOS.recv.bind(dbos.DBOS),
        randomUUID: dbos.DBOS.randomUUID.bind(dbos.DBOS),
    };

    // The body runs outside a workflow, thus the loop calls the model and each tool directly.
    Reflect.set(
        dbos.DBOS,
        "isInWorkflow",
        mock(() => false),
    );

    // Every `DBOS.runStep` runs its body inline — the body under test only needs
    // the steps to execute, not to be cached.
    Reflect.set(
        dbos.DBOS,
        "runStep",
        mock(async (fn: () => Promise<unknown>) => fn()),
    );

    // A pause test runs the body as the body of a workflow (`runInWorkflow`). The
    // fake `DBOS.recv` records the topic of the wait and gives the resume message
    // at once, as a host that resumes the run does.
    Reflect.set(
        dbos.DBOS,
        "recv",
        mock((topic: string) => {
            dbosState.recvTopics.push(topic);
            dbosState.onRecv?.();
            return Promise.resolve(RESUME_MESSAGE);
        }),
    );
    Reflect.set(
        dbos.DBOS,
        "randomUUID",
        mock(() => {
            dbosState.uuidCounter += 1;
            return Promise.resolve(`uuid-${dbosState.uuidCounter}`);
        }),
    );

    // The row of a pause names the workflow that waits.
    originalWorkflowId ??= Object.getOwnPropertyDescriptor(dbos.DBOS, "workflowID");
    Object.defineProperty(dbos.DBOS, "workflowID", { configurable: true, get: () => `${USAGE_RUN_ID}-${USAGE_STEP_ID}` });

    Reflect.set(
        dbos.DBOS,
        "send",
        mock((destination: string, message: unknown, topic?: string) => {
            dbosState.sent.push({ destination, message, topic });

            return Promise.resolve();
        }),
    );

    Reflect.set(
        dbos.DBOS,
        "cancelWorkflow",
        mock((workflowId: string | undefined) => {
            dbosState.cancelled.push(workflowId);

            return Promise.resolve();
        }),
    );

    Reflect.set(
        dbos.DBOS,
        "writeStream",
        mock((_name: string, part: unknown) => {
            const written = parseUnknownRecord(part);
            if (written) dbosState.emittedParts.push(written);
            return Promise.resolve(undefined);
        }),
    );

    Reflect.set(
        dbos.DBOS,
        "now",
        mock(() => {
            const t = dbosState.nowMs;
            dbosState.nowMs += FAKE_CLOCK_STEP_MS;
            return Promise.resolve(t);
        }),
    );
}

/**
 * Per-test workspace root. Hermetic on purpose: the post-step pipeline writes
 * `output/summary.md` under the step's write prefix, so a shared directory would
 * hand the NEXT run's artifact walk a file the step never produced.
 */
let workspaceRoot: string;

beforeEach(async () => {
    dbosState = { emittedParts: [], nowMs: FAKE_CLOCK_BASE_MS, sent: [], cancelled: [], recvTopics: [], onRecv: undefined, uuidCounter: 0 };
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
        Reflect.set(dbos.DBOS, name, fn);
    }
    if (originalWorkflowId) Object.defineProperty(dbos.DBOS, "workflowID", originalWorkflowId);
});

// ── Fakes for the step's deps ────────────────────────────────────────

const ANALYSIS_ID = "an-usage";
const USAGE_RUN_ID = "run-usage";
const USAGE_STEP_ID = "T1S1";
const USAGE_AGENT_ID = "scientific-executor";
const STEP_MODEL_ID = "test-step-model";

/** A pool that answers every query with an empty rowset — no ledger assertions here. */
function makeFakePool(): Querier {
    return { query: () => Promise.resolve({ rows: [], rowCount: 0 }) };
}

const SANDBOX_REF: SandboxRef = {
    sandboxId: "sbx-usage",
    host: "127.0.0.1",
    port: 8765,
    backend: "docker",
};

function makeSandboxClient(spawns: Array<{ session: SpawnSession; spec: SandboxSpec }> = []): SandboxClient {
    return {
        createSandbox: (session: SpawnSession, spec: SandboxSpec) => {
            spawns.push({ session, spec });
            return okAsync(SANDBOX_REF);
        },
        exec: () => {
            return Promise.reject(new Error("exec: the usage tests run a tool-less agent"));
        },
        isAlive: () => Promise.resolve({ alive: true, oomKilled: false }),
        isAliveById: () => Promise.resolve({ alive: true, oomKilled: false }),
        teardown: () => Promise.resolve(undefined),
        teardownById: () => Promise.resolve(undefined),
        listManagedSandboxes: () => Promise.resolve([]),
        toolchainSource: "store",
        resourceLimits: { maxCpu: 4, maxMemoryGb: 16, maxGpuCount: 0 },
    };
}

/** The requests of a step whose task and post-step continuations each end on their first reply. */
const ONE_REPLY_STEP_REQUESTS = 3;

/**
 * A model that answers each request of the step with one plain-text reply
 * carrying `usage`. The stop ends the loop on its first request, so the run's
 * rollup is exactly this call's usage.
 */
function makeProvider(usage: ChatUsage | undefined): ChatProvider {
    return scriptedModel(Array.from({ length: ONE_REPLY_STEP_REQUESTS }, () => reply([text("done")], "stop", usage))).provider;
}

function makeRunSession(): SpawnSession {
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
        runSession: makeRunSession(),
    };
}

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
 * Deps for a step whose agent declares only the output tool: one LLM call,
 * then an empty artifact tree.
 */
function usageStepDeps(usage: ChatUsage | undefined): SandboxStepDeps {
    return {
        citationResolver: unusedCitationResolver,
        pool: makeFakePool(),
        logger: silentLogger,
        runAuthorizer: createLocalRunAuthorizer(),
        provider: makeProvider(usage),
        embedding: { dimensions: 3, embed: (texts: readonly string[]) => okAsync(texts.map(() => [0, 0, 0])) },
        leases: fakeLeases(leaseOverClient(makeSandboxClient(), SANDBOX_REF)),
        artifactRegistry: {
            register: () => okAsync({ registered: [], failed: [], failedCount: 0 }),
            sync: () => okAsync(undefined),
        },
        workspaceFs: makeFakeWorkspaceFs(),
        resolveWorkspaceRoot: () => Promise.resolve(workspaceRoot),
        model: STEP_MODEL_ID,
        buildAgent: ({ fileMetadata }) => Promise.resolve(stepAgent(fileMetadata)),
        resolveWritePrefix: (stepInput) => Promise.resolve(join(workspaceRoot, "runs", stepInput.runId, stepInput.stepId)),
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
        const { type, id } = part;
        if (typeof type !== "string" || typeof id !== "string" || !isKnownPartType(type) || !isReconciling(type)) {
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
        expect(ChatPartSchema.safeParse(emitted[0]).success).toBe(true);
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

// ── the activity history: data-step-activity with a time, then data-activity-entry ──

describe("sandbox-step activity history", () => {
    const ENTRY_ID = `activity-entry-${USAGE_RUN_ID}-${USAGE_STEP_ID}`;
    const partsOf = (type: string) => dbosState.emittedParts.filter((part) => part.type === type);

    it("gives each activity part its time, and writes one matching entry after it", async () => {
        await runSandboxStepBody(usageStepInput(), usageStepDeps(undefined));

        const stream = dbosState.emittedParts.filter((part) => part.type === "data-step-activity" || part.type === "data-activity-entry");
        const activities = partsOf("data-step-activity");
        expect(activities.length).toBeGreaterThan(1);
        for (const activity of activities) expect(typeof activity.at === "string" && ISO_INSTANT.test(activity.at)).toBe(true);
        // Pairs in write order: the activity part, then its entry.
        expect(stream.map((part) => part.type)).toEqual(activities.flatMap(() => ["data-step-activity", "data-activity-entry"]));
        for (const [index, part] of stream.entries()) {
            if (part.type !== "data-activity-entry") continue;
            const { type: _type, id: _id, ...entry } = part;
            const { type: _activityType, id: _activityId, ...activity } = presentAt(stream, index - 1);
            expect(entry).toEqual(activity);
        }
        expect(ChatPartSchema.safeParse(partsOf("data-activity-entry")[0]).success).toBe(true);
    });

    it("gives the entries unique ids in sequence", async () => {
        await runSandboxStepBody(usageStepInput(), usageStepDeps(undefined));

        const ids = partsOf("data-activity-entry").map((part) => part.id);
        expect(ids).toEqual(ids.map((_, index) => `${ENTRY_ID}-${index}`));
    });

    it("keeps each entry in the local fold and folds the activity to the newest part", async () => {
        await runSandboxStepBody(usageStepInput(), usageStepDeps(undefined));

        const folded = foldStream(dbosState.emittedParts);
        expect(folded.filter((part) => part.type === "data-activity-entry")).toEqual(partsOf("data-activity-entry"));
        const activity = folded.filter((part) => part.type === "data-step-activity");
        expect(activity).toHaveLength(1);
        expect(activity[0]).toEqual(presentLast(partsOf("data-step-activity")));
    });

    it("logs a rejected entry write, continues the step, and gives the next entry the next number", async () => {
        const dbos = await import("@dbos-inc/dbos-sdk");
        let rejected = false;
        // A direct assignment through `unknown`, the same as `mockDbos`; the `afterAll` hook restores the original.
        Reflect.set(
            dbos.DBOS,
            "writeStream",
            mock((_name: string, part: unknown) => {
                const recorded = parseUnknownRecord(part);
                if (recorded === undefined) return Promise.resolve();
                if (!rejected && recorded.type === "data-activity-entry") {
                    rejected = true;
                    return Promise.reject(new Error("stream unavailable"));
                }
                dbosState.emittedParts.push(recorded);
                return Promise.resolve();
            }),
        );
        const logger = createCapturingLogger();

        const result = await runSandboxStepBody(usageStepInput(), { ...usageStepDeps(undefined), logger });

        expect(rejected).toBe(true);
        expect(result.status).toBe("complete");
        expect(logger.records.filter((r) => r.level === "warn" && r.msg.includes("emitToParentStream failed"))).toHaveLength(1);
        expect(presentAt(partsOf("data-activity-entry"), 0).id).toBe(`${ENTRY_ID}-1`);
        expect(presentLast(partsOf("data-step-activity")).phase).toBe("complete");
    });
});

// ── the output tool of the file-metadata continuation ───────────────

function toolResultIn(call: LanguageModelV4CallOptions, toolCallId: string): LanguageModelV4ToolResultPart | undefined {
    return call.prompt
        .flatMap((message) => (message.role === "tool" ? message.content : []))
        .flatMap((part) => (part.type === "tool-result" && part.toolCallId === toolCallId ? [part] : []))
        .at(0);
}

/** The prompt as text, with no cache marker: the marker moves to the last message of each request. */
function withoutCacheMarkers(prompt: LanguageModelV4Prompt): string {
    return JSON.stringify(prompt, (key, value: unknown) => (key === "providerOptions" ? undefined : value));
}

describe("sandbox-step file-metadata output tool", () => {
    it("masks submit_file_metadata during the task, thus the call gets the error of the mask", async () => {
        let cell: FileMetadataCell | undefined;
        const { provider, calls } = scriptedModel([
            callTools(
                toolCall("tu-meta", "submit_file_metadata", {
                    files: [{ path: "output/result.csv", description: "counts", dataType: "table", format: "csv" }],
                }),
            ),
            reply([text("done")]),
            reply([text("## Summary")]),
        ]);
        const deps: SandboxStepDeps = {
            ...usageStepDeps(undefined),
            provider,
            buildAgent: ({ fileMetadata }) => {
                cell = fileMetadata;
                return Promise.resolve(stepAgent(fileMetadata));
            },
        };

        const result = await runSandboxStepBody(usageStepInput(), deps);

        expect(result.status).toBe("complete");
        const refusal = toolResultIn(presentAt(calls, 1), "tu-meta");
        expect(refusal?.output.type).toBe("error-text");
        expect(JSON.stringify(refusal?.output)).toContain("The tool submit_file_metadata is not available for this request");
        expect(cell?.knownPaths).toBeNull();
        expect(cell?.described.size).toBe(0);
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
        const { provider, calls } = scriptedModel([
            reply([text("done")]),
            callTools(
                toolCall("m1", "submit_file_metadata", {
                    files: [{ path: "output/result.csv", description: "gene counts", dataType: "count matrix", format: "csv" }],
                }),
            ),
            reply([text("described")]),
            reply([text("## Summary")]),
        ]);

        const result = await runSandboxStepBody(usageStepInput(), { ...usageStepDeps(undefined), provider });

        expect(result.status).toBe("complete");
        expect(calls).toHaveLength(4);
        const metadataRequest = presentAt(calls, 1);
        const summaryRequest = presentAt(calls, 3);
        expect(summaryRequest.prompt.map((m) => m.role)).toEqual(["system", "user", "assistant", "user", "assistant", "tool", "assistant", "user"]);
        expect(withoutCacheMarkers(summaryRequest.prompt.slice(0, metadataRequest.prompt.length))).toBe(withoutCacheMarkers(metadataRequest.prompt));
        expect(summaryRequest.prompt[4]).toMatchObject({
            role: "assistant",
            content: [{ type: "tool-call", toolCallId: "m1", toolName: "submit_file_metadata" }],
        });
        expect(summaryRequest.prompt[6]).toMatchObject({ role: "assistant", content: [{ type: "text", text: "described" }] });
        expect(outputFiles()).toEqual([expect.objectContaining({ path: "output/result.csv", description: "gene counts" })]);
    });

    it("reads a cached metadata array of an earlier version as entries, and the summary continues the transcript directly", async () => {
        await seedStepOutput();
        const dbos = await import("@dbos-inc/dbos-sdk");
        const runInline = dbos.DBOS.runStep.bind(dbos.DBOS);
        const cached = [{ dbPath: `runs/${USAGE_RUN_ID}/${USAGE_STEP_ID}/output/result.csv`, description: "cached description", metadata: { format: "csv" } }];
        Reflect.set(
            dbos.DBOS,
            "runStep",
            mock(async (fn: () => Promise<unknown>, config?: { name?: string }) =>
                config?.name === "post-step.generate-file-metadata" ? cached : runInline(fn, config),
            ),
        );
        const { provider, calls } = scriptedModel([reply([text("done")]), reply([text("## Summary")])]);

        const result = await runSandboxStepBody(usageStepInput(), { ...usageStepDeps(undefined), provider });

        expect(result.status).toBe("complete");
        expect(calls).toHaveLength(2);
        expect(presentAt(calls, 1).prompt.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
        expect(outputFiles()).toEqual([expect.objectContaining({ path: "output/result.csv", description: "cached description" })]);
    });
});

// ── the kept text of a cut tool result ──────────────────────────────

describe("sandbox-step kept tool outputs", () => {
    function memoryStore(): ToolOutputStore & { readonly puts: KeptToolOutput[] } {
        const puts: KeptToolOutput[] = [];
        return {
            puts,
            put: (output) => {
                puts.push(output);
                return okAsync(undefined);
            },
            get: (analysisId, ref) => okAsync(puts.find((kept) => kept.analysisId === analysisId && kept.ref === ref) ?? null),
        };
    }

    /** The reference in the first excerpt of the messages of a request. */
    function referenceIn(call: LanguageModelV4CallOptions): string {
        const excerpt = call.prompt
            .flatMap((message) => (message.role === "tool" ? message.content : []))
            .map((part) => (part.type === "tool-result" && part.output.type === "text" ? part.output.value : ""))
            .find((value) => value.startsWith("[Tool result cut: "));
        const ref = referencedToolOutput(excerpt ?? "");
        if (ref === undefined) throw new Error("the tool-result cut notice is absent");
        return ref;
    }

    it("keeps the text of a long execute_command result of the task in the store of the step", async () => {
        const store = memoryStore();
        const stderr = "Traceback (most recent call last):\nValueError: no batch column";
        const sandboxClient = {
            ...makeSandboxClient(),
            exec: () =>
                Promise.resolve({
                    execId: "wf-1:3",
                    exitCode: 1,
                    stdout: "row\n".repeat(50_000),
                    stderr,
                    durationMs: 5,
                    timedOut: false,
                }),
        };
        const { provider, calls } = scriptedModel([
            callTools(toolCall("tu-x", "execute_command", { command: ["python", "run.py"] })),
            reply([text("done")]),
            reply([text("## Summary")]),
        ]);
        const deps: SandboxStepDeps = {
            ...usageStepDeps(undefined),
            provider,
            leases: fakeLeases(leaseOverClient(sandboxClient, SANDBOX_REF)),
            toolOutputStore: store,
            buildAgent: (ctx) => {
                if (ctx.toolOutputStore === undefined) return Promise.reject(new Error("the tool output store is absent"));
                return Promise.resolve(
                    stepAgent(ctx.fileMetadata, [
                        createExecuteCommandTool({
                            lease: ctx.lease,
                            defaultCwd: `/${ANALYSIS_ID}`,
                        }),
                        createReadToolOutputTool(ctx.toolOutputStore),
                    ]),
                );
            },
        };

        const result = await runSandboxStepBody(usageStepInput(), deps);

        expect(result.status).toBe("complete");
        expect(store.puts).toHaveLength(1);
        expect(store.puts[0]).toMatchObject({ analysisId: ANALYSIS_ID, toolName: "execute_command", toolCallId: "tu-x" });
        expect(store.puts[0]?.threadId).toBeUndefined();
        const excerpt = toolResultIn(presentAt(calls, 1), "tu-x");
        if (excerpt === undefined) throw new Error("excerpt is absent");
        if (excerpt.output.type !== "text") throw new Error(`expected a text excerpt, got ${excerpt.output.type}`);
        const tail = excerpt.output.value.split("\n").at(-1);
        if (tail === undefined) throw new Error("tail is absent");
        expect(tail).toContain("ValueError: no batch column");
        expect(tail).toContain('"timedOut":false');
    });

    it("lets the summary continuation read a kept text of the task with read_tool_output", async () => {
        const store = memoryStore();
        const big = defineTool({
            id: "big",
            description: "Give a long text.",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: () => Promise.resolve(ok("x".repeat(40_000))),
        });
        const { provider, calls } = scriptedModel([
            callTools(toolCall("tu-big", "big", {})),
            reply([text("done")]),
            (call) => callTools(toolCall("tu-read", "read_tool_output", { ref: referenceIn(call) })),
            reply([text("## Summary")]),
        ]);
        const deps: SandboxStepDeps = {
            ...usageStepDeps(undefined),
            provider,
            toolOutputStore: store,
            buildAgent: (ctx) => {
                if (ctx.toolOutputStore === undefined) return Promise.reject(new Error("the tool output store is absent"));
                return Promise.resolve(stepAgent(ctx.fileMetadata, [big, createReadToolOutputTool(ctx.toolOutputStore)]));
            },
        };

        const result = await runSandboxStepBody(usageStepInput(), deps);

        expect(result.status).toBe("complete");
        expect(calls).toHaveLength(4);
        const read = toolResultIn(presentAt(calls, 3), "tu-read");
        if (read === undefined) throw new Error("read is absent");
        if (read.output.type !== "json") throw new Error(`expected a json excerpt, got ${read.output.type}`);
        expect(read.output.value).toMatchObject({ status: "ok", offset: 0 });
    });

    it("logs one warn when the step has a store and its agent declares no read_tool_output", async () => {
        const logger = createCapturingLogger();
        const deps: SandboxStepDeps = { ...usageStepDeps(undefined), logger, toolOutputStore: memoryStore() };

        await runSandboxStepBody(usageStepInput(), deps);

        expect(logger.records.filter((r) => r.level === "warn" && r.msg.includes("declares no read_tool_output"))).toHaveLength(1);
    });
});

// ── a blocker ───────────────────────────────────────────────────────

describe("sandbox-step blocker", () => {
    const REASON = "The input has no batch column.";

    function blockerDeps(provider: ChatProvider, blocker: Tool = createReportBlockerTool()): SandboxStepDeps {
        return {
            ...usageStepDeps(undefined),
            provider,
            buildAgent: ({ fileMetadata }) => Promise.resolve(stepAgent(fileMetadata, [blocker])),
        };
    }

    function blockedParts(): Array<Record<string, unknown>> {
        return dbosState.emittedParts.filter((part) => part.type === "data-step-blocked");
    }

    it("stops the run at a blocker, and blocks the step with the reason of the call", async () => {
        // The script holds one reply, thus a second request of the run would fail the step.
        const { provider, calls } = scriptedModel([callTools(toolCall("b1", "report_blocker", { reason: REASON }))]);

        const result = await runSandboxStepBody(usageStepInput(), blockerDeps(provider));

        expect(result).toMatchObject({ status: "blocked", error: REASON, finishReason: "stop" });
        expect(calls).toHaveLength(1);
        expect(blockedParts().map((part) => part.reason)).toEqual([REASON]);
    });

    it("refuses a placeholder reason with an error result, records no blocker, and the run continues", async () => {
        const { provider, calls } = scriptedModel([
            callTools(toolCall("b1", "report_blocker", { reason: "TODO: fill in the reason" })),
            reply([text("done")]),
            reply([text("## Summary")]),
        ]);

        const result = await runSandboxStepBody(usageStepInput(), blockerDeps(provider));

        expect(result.status).toBe("complete");
        const refusal = toolResultIn(presentAt(calls, 1), "b1");
        expect(refusal?.output.type).toBe("error-text");
        expect(JSON.stringify(refusal?.output)).toContain("placeholder");
        expect(blockedParts()).toEqual([]);
    });

    it("takes the reason of the first report_blocker call whose result is ok, not of a call that failed its input schema", async () => {
        const { provider } = scriptedModel([
            callTools(
                toolCall("b0", "report_blocker", { reason: "" }),
                toolCall("b1", "report_blocker", { reason: "first recorded" }),
                toolCall("b2", "report_blocker", { reason: "second recorded" }),
            ),
        ]);

        const result = await runSandboxStepBody(usageStepInput(), blockerDeps(provider));

        expect(result).toMatchObject({ status: "blocked", error: "first recorded" });
    });

    it("keeps the blocked status on a replay, which returns the recorded model call and report_blocker call and runs neither again", async () => {
        const dbos = await import("@dbos-inc/dbos-sdk");
        // Inside a workflow, the loop runs each model call and each tool call as a step.
        Reflect.set(
            dbos.DBOS,
            "isInWorkflow",
            mock(() => true),
        );
        const recorded: Array<{ readonly name: string | undefined; readonly value: unknown }> = [];
        Reflect.set(
            dbos.DBOS,
            "runStep",
            mock(async (fn: () => Promise<unknown>, config?: { name?: string }) => {
                const value = await fn();
                recorded.push({ name: config?.name, value });
                return value;
            }),
        );
        let executes = 0;
        const blocker = createReportBlockerTool();
        const counted: Tool = {
            ...blocker,
            execute: (input, ctx) => {
                executes += 1;
                return blocker.execute(input, ctx);
            },
        };

        const first = await runSandboxStepBody(
            usageStepInput(),
            blockerDeps(scriptedModel([callTools(toolCall("b1", "report_blocker", { reason: REASON }))]).provider, counted),
        );

        // DBOS returns the recorded steps of a replay in the order of their function ids, and it refuses a step of a different name.
        let next = 0;
        Reflect.set(
            dbos.DBOS,
            "runStep",
            mock(async (fn: () => Promise<unknown>, config?: { name?: string }) => {
                const step = recorded[next];
                next += 1;
                if (step === undefined) return fn();
                if (step.name !== config?.name)
                    throw new Error(`the replay reached the step ${config?.name ?? "(unnamed)"} where the record holds ${step.name ?? "(unnamed)"}`);
                return step.value;
            }),
        );
        const replay = scriptedModel([]);
        const replayed = await runSandboxStepBody(usageStepInput(), blockerDeps(replay.provider, counted));

        const names = recorded.map((step) => step.name);
        expect(names).toContain(`${USAGE_AGENT_ID}.model`);
        expect(names).toContain("report_blocker.b1");
        expect(first).toMatchObject({ status: "blocked", error: REASON });
        expect(replayed).toMatchObject({ status: "blocked", error: REASON });
        expect(replay.calls).toHaveLength(0);
        expect(executes).toBe(1);
    });
});

// ── the spawn of the step sandbox ───────────────────────────────────

describe("sandbox-step lease", () => {
    it("binds the lease of the step under the step session, spawns nothing itself, and releases the lease at the end", async () => {
        const spawns: Array<{ session: SpawnSession; spec: SandboxSpec }> = [];
        const leases = fakeLeases(leaseOverClient(makeSandboxClient(spawns), SANDBOX_REF));
        const input = { ...usageStepInput(), image: "sandbox-base:test", extraEnv: { A: "1" } };

        const result = await runSandboxStepBody(input, { ...usageStepDeps(undefined), leases });

        expect(result.status).toBe("complete");
        expect(spawns).toHaveLength(0);
        expect(leases.bindings).toHaveLength(1);
        const binding = presentAt(leases.bindings, 0);
        expect(binding.leaseKey).toBe(`${USAGE_RUN_ID}-${USAGE_STEP_ID}`);
        expect(binding.session.runFrame).toEqual({ runId: USAGE_RUN_ID, stepId: USAGE_STEP_ID });
        expect(binding.work).toEqual({ kind: "run", id: USAGE_RUN_ID });
        expect(binding.spawn).toEqual({ image: "sandbox-base:test", extraEnv: { A: "1" } });
        expect(leases.releasedKeys).toEqual([binding.leaseKey]);
    });
});

// ── pause ─────────────────────────────────────────────────────────────

/**
 * Run the body as the body of a workflow, thus a cause of a pause waits in place. Each step still runs inline, and
 * the fake `DBOS.recv` ends each wait with the resume message.
 */
async function runInWorkflow(): Promise<void> {
    const dbos = await import("@dbos-inc/dbos-sdk");
    Reflect.set(
        dbos.DBOS,
        "isInWorkflow",
        mock(() => true),
    );
}

/** A pool that records each statement, with its values in both call forms. */
function statementPool(): { pool: Querier; statements: Array<{ text: string; values: readonly unknown[] }> } {
    const statements: Array<{ text: string; values: readonly unknown[] }> = [];
    const pool: Querier = {
        query: (arg, params) => {
            const text = typeof arg === "string" ? arg : arg.text;
            const values = typeof arg === "string" ? (params ?? []) : "values" in arg ? (arg.values ?? []) : (params ?? []);
            statements.push({ text, values });
            return Promise.resolve({ rows: [], rowCount: 0 });
        },
    };
    return { pool, statements };
}

const CHILD_ID = `${USAGE_RUN_ID}-${USAGE_STEP_ID}`;

/** The rows of a pause that the step wrote, and the deletes of a row of the step. */
function pauseStatements(statements: ReadonlyArray<{ text: string; values: readonly unknown[] }>): {
    readonly recorded: ReadonlyArray<{ text: string; values: readonly unknown[] }>;
    readonly cleared: ReadonlyArray<{ text: string; values: readonly unknown[] }>;
} {
    return {
        recorded: statements.filter((q) => PAUSE_RECORD_WRITE.test(q.text)),
        cleared: statements.filter((q) => PAUSE_CLEAR_WRITE.test(q.text)),
    };
}

/**
 * The step waited one time in `paused` with the host cause `reason`, under the run id, and the resume ended the wait:
 * the row is gone, and the latest part of the pause has the state `running`.
 */
function expectOnePauseResumed(statements: ReadonlyArray<{ text: string; values: readonly unknown[] }>, reason: string): void {
    const { recorded, cleared } = pauseStatements(statements);
    expect(recorded).toHaveLength(1);
    const [workflowId, workId, workKind, analysisId, , state, cause, attempt, , topic] = presentAt(recorded, 0).values;
    expect([workflowId, workId, workKind, analysisId, state, attempt]).toEqual([CHILD_ID, USAGE_RUN_ID, "run", ANALYSIS_ID, "paused", 0]);
    expect(cause).toBe(JSON.stringify({ kind: "host", reason }));
    expect(dbosState.recvTopics).toHaveLength(1);
    expect(topic).toBe(dbosState.recvTopics[0]);
    expect(cleared.map((q) => q.values)).toEqual([[CHILD_ID]]);

    const parts = dbosState.emittedParts.filter((part) => part.type === "data-pause");
    expect(parts).toMatchObject([
        { id: CHILD_ID, workId: USAGE_RUN_ID, workKind: "run", state: "paused", cause: { kind: "host", reason } },
        { id: CHILD_ID, workId: USAGE_RUN_ID, workKind: "run", state: "running" },
    ]);
    for (const part of parts) expect(ChatPartSchema.safeParse(part).success).toBe(true);
    // The step waits in place: it writes no terminal row for the pause, and it does not cancel itself.
    expect(statements.filter((q) => STEP_EXECUTIONS_UPDATE.test(q.text) && q.values.includes("canceled"))).toEqual([]);
    expect(dbosState.cancelled).toEqual([]);
}

describe("sandbox-step pause", () => {
    it("a failed model request with a cause pauses the step in place, and the step sends the request again after the resume", async () => {
        const { pool, statements } = statementPool();
        const script = scriptedModel([
            {
                fail: new APICallError({
                    message: "Payment Required",
                    url: "https://model.test/v1/messages",
                    requestBodyValues: {},
                    statusCode: 402,
                    isRetryable: false,
                }),
            },
            ...Array.from({ length: ONE_REPLY_STEP_REQUESTS }, () => reply([text("done")])),
        ]);
        // The default map of the provider reads a 402 as the host cause `payment_required`.
        const deps: SandboxStepDeps = { ...usageStepDeps(undefined), pool, provider: script.provider };
        await runInWorkflow();

        const result = await runSandboxStepBody(usageStepInput(), deps);

        expect(result.status).toBe("complete");
        expectOnePauseResumed(statements, "payment_required");
        // The failed request had no partial reply, thus the step sent the same messages again.
        expect(presentAt(script.calls, 1).prompt).toEqual(presentAt(script.calls, 0).prompt);
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

    type AttestationProbe = {
        readonly deps: SandboxStepDeps;
        /** Every `sync` call, in order. */
        readonly syncCalls: ArtifactSyncInput[];
        /** `"register"` / `"sync"` in invocation order. */
        readonly order: string[];
    };

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
            deps: { ...usageStepDeps(undefined), logger: args.logger, artifactRegistry },
            syncCalls,
            order,
        };
    }

    const SYNC_INPUT: ArtifactSyncInput = { resourceId: ANALYSIS_ID, runId: USAGE_RUN_ID, stepId: USAGE_STEP_ID };

    /** The `step failure` record — the only account of why a scrubbed step died. */
    function stepFailure(logger: CapturingLogger): { errorClass: unknown; err: string } | undefined {
        const rec = logger.records.find((r) => r.msg.endsWith("step failure"));
        return rec ? { errorClass: rec.fields.errorClass, err: textOf(rec.fields.err) } : undefined;
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

    it("pauses the step when the register gate refuses with the suspend flag, and registers again after the resume", async () => {
        await seedStepOutput();
        const { pool, statements } = statementPool();
        const order: string[] = [];
        const artifactRegistry: ArtifactRegistry = {
            register: () => {
                order.push("register");
                if (order.filter((op) => op === "register").length === 1) return errAsync({ reason: "ledger frozen", suspend: true });
                return okAsync({ registered: [], failed: [], failedCount: 0 });
            },
            sync: () => {
                order.push("sync");
                return okAsync(undefined);
            },
        };
        await runInWorkflow();

        const result = await runSandboxStepBody(usageStepInput(), { ...usageStepDeps(undefined), pool, artifactRegistry });

        expect(result.status).toBe("complete");
        expect(order).toEqual(["register", "sync", "register", "sync"]);
        expectOnePauseResumed(statements, "ledger frozen");
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
    function makeRecordingPool(): { pool: Querier; values: unknown[] } {
        const values: unknown[] = [];
        const pool: Querier = {
            query: (arg, params) => {
                if (typeof arg !== "string" && "values" in arg) {
                    const fromConfig: readonly unknown[] = arg.values ?? [];
                    values.push(...fromConfig);
                }
                values.push(...(params ?? []));
                return Promise.resolve({ rows: [], rowCount: 0 });
            },
        };
        return { pool, values };
    }

    /**
     * Deps whose loop caps out: a one-iteration agent with one `echo` tool, and
     * a provider whose first reply is a tool call. Each post-step continuation
     * gets a plain "done", and the loop ends with `finish.cappedOut: true` and
     * `reason: "max_iterations"`.
     */
    function cappedOutDeps(): { deps: SandboxStepDeps; values: unknown[] } {
        const { pool, values } = makeRecordingPool();
        const { provider } = scriptedModel([callTools(toolCall("tu-1", "echo", { label: "x" })), reply([text("done")]), reply([text("done")])]);
        const deps: SandboxStepDeps = {
            ...usageStepDeps(undefined),
            pool,
            provider,
            buildAgent: ({ fileMetadata }) =>
                Promise.resolve(
                    stepAgent(
                        fileMetadata,
                        [
                            defineTool({
                                id: "echo",
                                description: "Echo the label back.",
                                inputSchema: z.object({ label: z.string() }),
                                describeCall: "none",
                                execute: ({ label }) => Promise.resolve(ok({ label })),
                            }),
                        ],
                        1,
                    ),
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
        expect(presentAt(emitted, 0).reason).toBe(CAPPED_OUT_EMPTY_REASON);
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

    it("keeps the blocker's own reason when the blocker comes in the last request that the cap lets run", async () => {
        const { pool } = makeRecordingPool();
        const { provider } = scriptedModel([callTools(toolCall("b1", "report_blocker", { reason: "the input has no batch column" }))]);
        const deps: SandboxStepDeps = {
            ...usageStepDeps(undefined),
            pool,
            provider,
            buildAgent: ({ fileMetadata }) => Promise.resolve(stepAgent(fileMetadata, [createReportBlockerTool()], 1)),
        };

        const result = await runSandboxStepBody(usageStepInput(), deps);

        expect(result.status).toBe("blocked");
        expect(result.error).toBe("the input has no batch column");
        // The blocker ends the run before the cap does.
        expect(result.finishReason).toBe("stop");
        const emitted = blockedParts(dbosState.emittedParts);
        expect(emitted.length).toBe(1);
        expect(presentAt(emitted, 0).reason).toBe("the input has no batch column");
    });
});
