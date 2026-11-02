/**
 * Per-call usage records + finish rollups (the llm-usage-accounting capability).
 *
 * Everything here is asserted from state — the records a test recorder
 * collected, and the rollups `runLoop` returns — never from how the loop
 * reached them.
 */

import { inProcessSubAgent } from "../sub-agent.js";
import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it } from "bun:test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { errAsync, ok, okAsync } from "neverthrow";
import { z } from "zod";

import { forSubAgent, type AgentSession } from "../../auth/types.js";
import type { LlmUsageRecord, UsageRecorder } from "../../billing/usage-recorder.js";
import { presentFirst } from "../../lib/present.js";
import { createCapturingLogger } from "../../__tests__/setup/logger.js";
import { makeSession } from "../../providers/__fixtures__/session.js";
import { createAiSdkProvider } from "../../providers/ai-sdk.js";
import type { ChatProvider, ChatUsage } from "../../providers/types.js";
import { defineTool, type Tool } from "../../tools/define-tool.js";
import { createGenerateAnalogyReportTool } from "../../tools/research/generate-analogy-report.js";
import { reply, scriptedModel, text, toolCall, type ScriptedModel, type ScriptedReply, type ScriptStep } from "../../testing.js";
import { runLoop, type AgentFinish, type LoopOptions } from "../run-loop.js";
import type { AgentDefinition } from "../types.js";

// ── Harness helpers ─────────────────────────────────────────────────

const GO: ReadonlyArray<{ role: "user"; content: string }> = [{ role: "user", content: "go" }];

function agentDef(tools: Tool[], maxIterations = 8, id = "test-agent"): AgentDefinition {
    return { id, systemPrompt: "You are a test agent.", model: "claude-test", tools, maxIterations };
}

/** A recorder whose collected records are the assertion surface. */
function recordingRecorder(): { recorder: UsageRecorder; records: LlmUsageRecord[] } {
    const records: LlmUsageRecord[] = [];
    return {
        recorder: {
            record: (record) => {
                records.push(record);
                return okAsync(undefined);
            },
        },
        records,
    };
}

function opts(provider: ChatProvider, recorder: UsageRecorder, overrides: Partial<LoopOptions> = {}): LoopOptions {
    return {
        provider,
        signal: new AbortController().signal,
        emit: () => {},
        usageRecorder: recorder,
        ...overrides,
    };
}

/** A session inside a run step — the shape that makes record keys replay-stable. */
function runFramedSession(stepId = "step-a"): AgentSession {
    return { ...makeSession(), runFrame: { runId: "run-1", stepId } };
}

/** A session in the parent workflow of a run — a `RunFrame` carrying no `stepId`. */
function parentFramedSession(): AgentSession {
    return { ...makeSession(), runFrame: { runId: "run-1" } };
}

function usage(inputTokens: number, outputTokens: number): ChatUsage {
    return { inputTokens, outputTokens };
}

const echoTool: Tool = defineTool({
    id: "echo",
    description: "Echo the label back.",
    inputSchema: z.object({ label: z.string() }),
    view: "none",
    describeCall: "none",
    execute: ({ label }) => Promise.resolve(ok({ label })),
});

/** `requests` replies that each ask for a tool, thus a run with that cap never ends on its own. */
function neverTerminates(requests: number, replyUsage: ChatUsage): ScriptedModel {
    return scriptedModel(Array.from({ length: requests }, (_, i) => reply([toolCall(`tu-${i}`, "echo", { label: "x" })], "tool-calls", replyUsage)));
}

/** A model whose stream names no model and no response: it sends no response metadata. */
function unnamedModel(inputTokens: number): ChatProvider {
    const parts: LanguageModelV4StreamPart[] = [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "p0" },
        { type: "text-delta", id: "p0", delta: "done" },
        { type: "text-end", id: "p0" },
        {
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
                inputTokens: { total: inputTokens, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: undefined, text: undefined, reasoning: undefined },
            },
        },
    ];
    const model = new MockLanguageModelV4({ doStream: () => Promise.resolve({ stream: convertArrayToReadableStream(parts) }) });
    return createAiSdkProvider({ model, maxRetries: 0 });
}

// ── One record per completed call ───────────────────────────────────

describe("runLoop usage records — one per completed call", () => {
    it("delivers a record for every call", async () => {
        const { recorder, records } = recordingRecorder();

        await runLoop(agentDef([echoTool], 3), GO, makeSession(), opts(neverTerminates(3, usage(10, 2)).provider, recorder));

        // 3 capped iterations.
        expect(records).toHaveLength(3);
        expect(records.every((r) => r.usage.inputTokens === 10)).toBe(true);
    });

    it("logs a recorder err at the error level, and the run finishes the same as with a recorder that succeeds", async () => {
        const failing: UsageRecorder = { record: () => errAsync({ reason: "ledger offline" }) };
        const log = createCapturingLogger();

        const withFailure = await runLoop(
            agentDef([echoTool], 3),
            GO,
            makeSession(),
            opts(neverTerminates(3, usage(10, 2)).provider, failing, { logger: log }),
        );
        const withSuccess = await runLoop(
            agentDef([echoTool], 3),
            GO,
            makeSession(),
            opts(neverTerminates(3, usage(10, 2)).provider, recordingRecorder().recorder),
        );
        // The loop does not wait for a notice, thus its log lands on a later turn of the event loop.
        await sleep(0);

        expect(withFailure.finish).toEqual(withSuccess.finish);
        const failures = log.records.filter((r) => r.level === "error" && r.fields.notice === "UsageRecorder.record");
        expect(failures).toHaveLength(3);
        expect(failures.every((r) => r.fields.reason === "ledger offline")).toBe(true);
    });

    it("carries the session attribution and both model ids on each record", async () => {
        const { recorder, records } = recordingRecorder();
        const { provider } = scriptedModel([{ ...reply([text("done")], "stop", usage(11, 3)), modelId: "answered-with" }]);

        await runLoop(agentDef([]), GO, runFramedSession(), opts(provider, recorder));

        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
            agentId: "test-agent",
            callPath: ["conversation-agent"],
            scope: { kind: "analysis", analysisId: "analysis-001" },
            runId: "run-1",
            stepId: "step-a",
            // The id of the model that the run asked for, and the id that the response named.
            requestedModelId: "scripted-model",
            servedModelId: "answered-with",
            usage: { inputTokens: 11, outputTokens: 3 },
        });
    });

    it("leaves unreported attribution absent rather than undefined-valued", async () => {
        const { recorder, records } = recordingRecorder();

        // A `RequestSession` — no RunFrame, and the response named no model.
        await runLoop(agentDef([]), GO, makeSession(), opts(unnamedModel(4), recorder));

        const record = presentFirst(records);
        expect("runId" in record).toBe(false);
        expect("stepId" in record).toBe(false);
        expect("servedModelId" in record).toBe(false);
    });

    it("produces no record for a call that reported nothing", async () => {
        const { recorder, records } = recordingRecorder();
        const { provider } = scriptedModel([reply([text("done")])]);

        const { finish } = await runLoop(agentDef([]), GO, makeSession(), opts(provider, recorder));

        expect(records).toHaveLength(0);
        expect(finish.usage).toBeUndefined();
        expect(finish.turnUsage).toBeUndefined();
    });

    it("produces no record when a reply carries model ids but no usage figures", async () => {
        const { recorder, records } = recordingRecorder();
        // The shape a provider that reports identity but no accounting yields:
        // every usage field present as a key, none of them reported.
        const { provider } = scriptedModel([
            {
                ...reply([text("done")], "stop", {
                    inputTokens: undefined,
                    outputTokens: undefined,
                    cacheCreationInputTokens: undefined,
                    cacheReadInputTokens: undefined,
                    reasoningTokens: undefined,
                }),
                modelId: "answered-with",
            },
        ]);

        await runLoop(agentDef([]), GO, makeSession(), opts(provider, recorder));

        expect(records).toHaveLength(0);
    });

    it("records a call that reported usage without a cache breakdown, leaving the rest absent", async () => {
        const { recorder, records } = recordingRecorder();
        const { provider } = scriptedModel([reply([text("done")], "stop", { inputTokens: 7 })]);

        await runLoop(agentDef([]), GO, makeSession(), opts(provider, recorder));

        expect(presentFirst(records).usage).toEqual({ inputTokens: 7 });
    });
});

// ── Delivery precedes termination ───────────────────────────────────

describe("runLoop usage records — delivered as calls complete", () => {
    it("has already delivered the earlier calls when a later call fails fatally", async () => {
        const { recorder, records } = recordingRecorder();
        const script: ScriptStep[] = [
            reply([toolCall("tu-0", "echo", { label: "x" })], "tool-calls", usage(10, 2)),
            reply([toolCall("tu-1", "echo", { label: "x" })], "tool-calls", usage(10, 2)),
            { fail: new Error("upstream exploded") },
        ];

        await expect(runLoop(agentDef([echoTool]), GO, makeSession(), opts(scriptedModel(script).provider, recorder))).rejects.toThrow("upstream exploded");

        // The two calls that completed before the fatal third are in the ledger.
        expect(records).toHaveLength(2);
    });

    // The AI SDK cancels the stream of the request when the signal fires, thus the loop reads no part of the
    // reply. A provider whose stream an abort cuts has sent no usage either.
    it("records nothing for a reply that an abort cut before the loop read it", async () => {
        const { recorder, records } = recordingRecorder();
        const controller = new AbortController();
        const script: ScriptStep[] = [
            () => {
                controller.abort();
                return reply([text("a partial the user cut off")], "stop", usage(9, 4));
            },
        ];

        const { finish } = await runLoop(agentDef([]), GO, makeSession(), opts(scriptedModel(script).provider, recorder, { signal: controller.signal }));

        expect(finish.reason).toBe("aborted");
        expect(records).toHaveLength(0);
    });

    it("folds the tokens of an aborted reply into the finish rollup, the same as the record", async () => {
        const { recorder, records } = recordingRecorder();
        const controller = new AbortController();
        const slow = defineTool({
            id: "slow",
            description: "Runs until the user aborts.",
            inputSchema: z.object({}),
            view: "none",
            describeCall: "none",
            execute: () => {
                controller.abort();
                return Promise.resolve(ok({ done: true }));
            },
        });
        const script = [reply([toolCall("tu-1", "slow", {})], "tool-calls", usage(9, 4))];

        const { finish } = await runLoop(agentDef([slow]), GO, makeSession(), opts(scriptedModel(script).provider, recorder, { signal: controller.signal }));

        expect(finish.reason).toBe("aborted");
        expect(presentFirst(records).usage).toEqual({ inputTokens: 9, outputTokens: 4 });
        expect(finish.usage).toEqual({ inputTokens: 9, outputTokens: 4 });
        expect(finish.turnUsage).toEqual({ inputTokens: 9, outputTokens: 4 });
    });
});

// ── Record keys ─────────────────────────────────────────────────────

describe("runLoop usage records — replay-safe keys", () => {
    /** Two calls: a tool round, then a terminal reply. The scripted model names them `response-0` and `response-1`. */
    const twoCallScript = (): ChatProvider =>
        scriptedModel([reply([toolCall("tu-fixed", "echo", { label: "x" })], "tool-calls", usage(10, 2)), reply([text("done")], "stop", usage(5, 1))]).provider;

    it("composes the identical keys from runId, stepId, call path and response id across two identical runs", async () => {
        const first = recordingRecorder();
        await runLoop(agentDef([echoTool]), GO, runFramedSession(), opts(twoCallScript(), first.recorder));

        const second = recordingRecorder();
        await runLoop(agentDef([echoTool]), GO, runFramedSession(), opts(twoCallScript(), second.recorder));

        expect(first.records.map((r) => r.recordKey)).toEqual(["run-1:step-a:conversation-agent:response-0", "run-1:step-a:conversation-agent:response-1"]);
        expect(second.records.map((r) => r.recordKey)).toEqual(first.records.map((r) => r.recordKey));
    });

    it("keeps two steps of one run disjoint despite identical response ids", async () => {
        // Sibling step workflows share the runId, and their calls can carry the
        // same response id; only the stepId tells the two calls apart, and
        // without it an upserting sink would count them as one.
        const stepA = recordingRecorder();
        await runLoop(agentDef([echoTool]), GO, runFramedSession("step-a"), opts(twoCallScript(), stepA.recorder));

        const stepB = recordingRecorder();
        await runLoop(agentDef([echoTool]), GO, runFramedSession("step-b"), opts(twoCallScript(), stepB.recorder));

        const keysA = stepA.records.map((r) => r.recordKey);
        const keysB = stepB.records.map((r) => r.recordKey);
        expect(keysA).toEqual(["run-1:step-a:conversation-agent:response-0", "run-1:step-a:conversation-agent:response-1"]);
        expect(keysB).toEqual(["run-1:step-b:conversation-agent:response-0", "run-1:step-b:conversation-agent:response-1"]);
        expect(keysA.filter((k) => keysB.includes(k))).toEqual([]);
    });

    it("keeps sibling loops sharing one frame disjoint despite identical response ids", async () => {
        // The post-step describer and the summary writer run under the SAME
        // `{runId, stepId}`; the provenance call path is the only thing that
        // separates them.
        const frame = runFramedSession();

        const describer = recordingRecorder();
        await runLoop(agentDef([echoTool], 8, "file-describer"), GO, forSubAgent(frame, "file-describer"), opts(twoCallScript(), describer.recorder));

        const writer = recordingRecorder();
        await runLoop(agentDef([echoTool], 8, "step-summary-writer"), GO, forSubAgent(frame, "step-summary-writer"), opts(twoCallScript(), writer.recorder));

        const describerKeys = describer.records.map((r) => r.recordKey);
        const writerKeys = writer.records.map((r) => r.recordKey);
        expect(describerKeys).toEqual([
            "run-1:step-a:conversation-agent>file-describer:response-0",
            "run-1:step-a:conversation-agent>file-describer:response-1",
        ]);
        expect(writerKeys).toEqual([
            "run-1:step-a:conversation-agent>step-summary-writer:response-0",
            "run-1:step-a:conversation-agent>step-summary-writer:response-1",
        ]);
        expect(describerKeys.filter((k) => writerKeys.includes(k))).toEqual([]);
    });

    it("drops the stepId segment for a frame that carries none", async () => {
        const { recorder, records } = recordingRecorder();

        await runLoop(agentDef([echoTool]), GO, parentFramedSession(), opts(twoCallScript(), recorder));

        // The parent workflow's loops collide with nothing — their keys are one
        // segment shorter than any step's.
        expect(records.map((r) => r.recordKey)).toEqual(["run-1:conversation-agent:response-0", "run-1:conversation-agent:response-1"]);
        expect(presentFirst(records).stepId).toBeUndefined();
    });

    it("uses the response id of the provider verbatim as the last segment", async () => {
        const { recorder, records } = recordingRecorder();
        const { provider } = scriptedModel([{ ...reply([text("done")], "stop", usage(3, 1)), responseId: "msg_01:abc" }]);

        await runLoop(agentDef([]), GO, runFramedSession(), opts(provider, recorder));

        expect(presentFirst(records).recordKey).toBe("run-1:step-a:conversation-agent:msg_01:abc");
    });

    it("mints a distinct key per call outside a RunFrame", async () => {
        const { recorder, records } = recordingRecorder();

        await runLoop(agentDef([echoTool]), GO, makeSession(), opts(twoCallScript(), recorder));

        const keys = records.map((r) => r.recordKey);
        expect(keys).toHaveLength(2);
        expect(new Set(keys).size).toBe(2);
    });
});

// ── Sub-agent runs and the turn total ───────────────────────────────

/** A tool that drives a child loop, mirroring the sub-agent tool factories. */
function delegateTool(childProvider: ChatProvider, recorder: UsageRecorder, capture: { finish?: AgentFinish }): Tool {
    const child = agentDef([], 4, "child-agent");
    return defineTool({
        id: "delegate",
        description: "Run a child agent.",
        inputSchema: z.object({}),
        view: "none",
        describeCall: "none",
        execute: async (_input, ctx) => {
            const result = await runLoop(child, [{ role: "user", content: "child go" }], forSubAgent(ctx.session, "child-agent"), {
                provider: childProvider,
                signal: ctx.signal,
                emit: ctx.emit,
                usageRecorder: recorder,
                turnUsage: ctx.turnUsage,
                invocationId: ctx.invocationId,
            });
            capture.finish = result.finish;
            return ok({ delegated: true });
        },
    });
}

/** The parent: one round that delegates, then a terminal reply. */
function delegatingParent(): ChatProvider {
    return scriptedModel([reply([toolCall("tu-1", "delegate", {})], "tool-calls", usage(10, 2)), reply([text("done")], "stop", usage(5, 1))]).provider;
}

describe("runLoop usage — sub-agent runs", () => {
    it("records the child's calls under the child agentId and extended callPath", async () => {
        const { recorder, records } = recordingRecorder();
        const capture: { finish?: AgentFinish } = {};
        const child = scriptedModel([reply([text("child done")], "stop", usage(100, 20))]).provider;

        await runLoop(agentDef([delegateTool(child, recorder, capture)]), GO, makeSession(), opts(delegatingParent(), recorder));

        const childRecords = records.filter((r) => r.agentId === "child-agent");
        expect(childRecords).toHaveLength(1);
        expect(presentFirst(childRecords).callPath).toEqual(["conversation-agent", "child-agent"]);
        expect(presentFirst(childRecords).usage).toEqual({ inputTokens: 100, outputTokens: 20 });

        // The parent's own calls stay under the parent — the ledger spans the tree.
        expect(records.filter((r) => r.agentId === "test-agent")).toHaveLength(2);
    });

    it("totals the whole turn on the root finish while the child reports only its own", async () => {
        const { recorder } = recordingRecorder();
        const capture: { finish?: AgentFinish } = {};
        const child = scriptedModel([reply([text("child done")], "stop", usage(100, 20))]).provider;

        const { finish } = await runLoop(agentDef([delegateTool(child, recorder, capture)]), GO, makeSession(), opts(delegatingParent(), recorder));

        expect(finish.usage).toEqual({ inputTokens: 15, outputTokens: 3 });
        expect(finish.turnUsage).toEqual({ inputTokens: 115, outputTokens: 23 });

        // The child created no accumulator, so it is not the root and reports no turn total.
        const childFinish = capture.finish;
        if (childFinish === undefined) throw new Error("the child run recorded no finish");
        expect(childFinish.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
        expect(childFinish.turnUsage).toBeUndefined();
    });

    it("keeps parallel invocations of one sub-agent disjoint", async () => {
        // Both child loops run under the same frame and the same call path, and
        // their replies carry the same response id; the dispatching tool-call id
        // is the only thing left to tell them apart.
        const { recorder, records } = recordingRecorder();
        const capture: { finish?: AgentFinish } = {};
        const parent = scriptedModel([
            reply([toolCall("tu-a", "delegate", {}), toolCall("tu-b", "delegate", {})], "tool-calls", usage(10, 2)),
            reply([text("done")], "stop", usage(5, 1)),
        ]).provider;
        const childReply = (): ScriptedReply => ({ ...reply([text("child done")], "stop", usage(100, 20)), responseId: "child-response" });
        const child = scriptedModel([childReply(), childReply()]).provider;

        await runLoop(agentDef([delegateTool(child, recorder, capture)]), GO, runFramedSession(), opts(parent, recorder));

        const childKeys = records.filter((r) => r.agentId === "child-agent").map((r) => r.recordKey);
        expect(childKeys).toHaveLength(2);
        expect(new Set(childKeys)).toEqual(
            new Set(["run-1:step-a:conversation-agent>child-agent:tu-a:child-response", "run-1:step-a:conversation-agent>child-agent:tu-b:child-response"]),
        );
    });

    it("threads the deps bag and the turn accumulator through a real sub-agent factory", async () => {
        // The tests above drive a stand-in tool written here, which proves the loop
        // honours what a tool passes down but not that any shipped factory passes
        // it. `createGenerateAnalogyReportTool` is the lightest real one — a provider,
        // a model label, and empty API keys — so it is what pins the wiring the
        // factories actually carry: the recorder from its deps, `ctx.turnUsage`,
        // and `ctx.invocationId`.
        const { recorder, records } = recordingRecorder();
        const childProvider = scriptedModel([reply([text("evidence report")], "stop", usage(100, 20))]).provider;
        const reasoner = createGenerateAnalogyReportTool(
            { provider: childProvider, model: "claude-test", bioKeys: { drugbank: "", disgenet: "", epaCcte: "" }, usageRecorder: recorder },
            inProcessSubAgent,
        );
        const parent = scriptedModel([
            reply([toolCall("tu-lit", "generate_analogy_report", { problem: "profile these genes" })], "tool-calls", usage(10, 2)),
            reply([text("done")], "stop", usage(5, 1)),
        ]).provider;

        const { finish } = await runLoop(agentDef([reasoner]), GO, runFramedSession(), opts(parent, recorder));

        const childRecords = records.filter((r) => r.agentId === "analogical-reasoner");
        expect(childRecords).toHaveLength(1);
        expect(presentFirst(childRecords).callPath).toEqual(["conversation-agent", "analogical-reasoner"]);
        expect(presentFirst(childRecords).usage).toEqual({ inputTokens: 100, outputTokens: 20 });
        // The dispatching tool call's id rides in the key — the discriminator that
        // only reaches the child because the factory forwards `ctx.invocationId`.
        expect(presentFirst(childRecords).recordKey).toBe("run-1:step-a:conversation-agent>analogical-reasoner:tu-lit:response-0");

        // The child folded into the root's accumulator rather than a private one.
        expect(finish.usage).toEqual({ inputTokens: 15, outputTokens: 3 });
        expect(finish.turnUsage).toEqual({ inputTokens: 115, outputTokens: 23 });
    });

    it("reports no turn total when the caller supplied the accumulator", async () => {
        const { recorder } = recordingRecorder();
        const { provider } = scriptedModel([reply([text("done")], "stop", usage(5, 1))]);
        const inherited = {};

        const { finish } = await runLoop(agentDef([]), GO, makeSession(), opts(provider, recorder, { turnUsage: inherited }));

        expect(finish.usage).toEqual({ inputTokens: 5, outputTokens: 1 });
        expect(finish.turnUsage).toBeUndefined();
        // The caller's accumulator carries the run's tokens for whoever owns it.
        expect(inherited).toEqual({ inputTokens: 5, outputTokens: 1 });
    });
});

// ── Rollups over the whole run ──────────────────────────────────────

describe("runLoop usage — finish rollups", () => {
    it("sums every call of a capped run", async () => {
        const { recorder } = recordingRecorder();

        const { finish } = await runLoop(agentDef([echoTool], 3), GO, makeSession(), opts(neverTerminates(3, usage(10, 2)).provider, recorder));

        expect(finish.cappedOut).toBe(true);
        expect(finish.usage).toEqual({ inputTokens: 30, outputTokens: 6 });
        expect(finish.turnUsage).toEqual({ inputTokens: 30, outputTokens: 6 });
    });

    it("carries reasoning tokens through the fold when reported", async () => {
        const { recorder } = recordingRecorder();
        const { provider } = scriptedModel([
            reply([toolCall("tu-1", "echo", { label: "x" })], "tool-calls", { inputTokens: 10, outputTokens: 4, reasoningTokens: 3 }),
            reply([text("done")], "stop", { inputTokens: 5, outputTokens: 2 }),
        ]);

        const { finish } = await runLoop(agentDef([echoTool]), GO, makeSession(), opts(provider, recorder));

        expect(finish.usage).toEqual({ inputTokens: 15, outputTokens: 6, reasoningTokens: 3 });
    });

    it("leaves both rollups absent when no call reported usage", async () => {
        const { recorder, records } = recordingRecorder();

        const { finish } = await runLoop(agentDef([echoTool], 3), GO, makeSession(), opts(neverTerminates(3, {}).provider, recorder));

        expect(records).toHaveLength(0);
        expect(finish.usage).toBeUndefined();
        expect(finish.turnUsage).toBeUndefined();
    });
});
