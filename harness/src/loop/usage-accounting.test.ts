/**
 * Per-call usage records + finish rollups (the llm-usage-accounting capability).
 *
 * Everything here is asserted from state — the records a test recorder
 * collected, and the rollups `runAgent` returns — never from how the loop
 * reached them.
 */

import { describe, expect, it } from "bun:test";
import { errAsync, ok, okAsync } from "neverthrow";
import { z } from "zod";

import { forSubAgent, type AgentSession } from "../auth/types.js";
import type { LlmUsageRecord, UsageRecorder } from "../billing/usage-recorder.js";
import { makeSession } from "../providers/__fixtures__/session.js";
import type { ChatProvider, ChatRequest, ChatResponse, ChatStreamEvent, ChatUsage } from "../providers/types.js";
import { defineTool, type Tool } from "../tools/define-tool.js";
import { createLiteratureReviewerTool } from "../tools/research/literature-reviewer.js";
import { unusedCitationResolver } from "../citations/__fixtures__/resolver.js";
import { makeMessage, scriptedProvider, type ScriptedProvider, textBlock, toolUseBlock } from "./__fixtures__/scripted-provider.js";
import { runAgent, type AgentFinish, type RunAgentOptions } from "./run-agent.js";
import { passthroughStep } from "./run-step.js";
import type { AgentDefinition, RunStep } from "./types.js";

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
            },
        },
        records,
    };
}

function opts(provider: ChatProvider, recorder: UsageRecorder, overrides: Partial<RunAgentOptions> = {}): RunAgentOptions {
    return {
        provider,
        signal: new AbortController().signal,
        emit: () => {},
        runStep: passthroughStep,
        usageRecorder: recorder,
        ...overrides,
    };
}

/**
 * A `RunStep` that caches by step name, standing in for the durability engine:
 * a second run over the same inputs re-executes the loop body while every step
 * it already completed returns its recorded value without calling the body.
 */
function cachingStep(): { runStep: RunStep; names: string[] } {
    const cache = new Map<string, unknown>();
    const names: string[] = [];
    const runStep: RunStep = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        names.push(name);
        if (cache.has(name)) return cache.get(name) as T;
        const value = await fn();
        cache.set(name, value);
        return value;
    };
    return { runStep, names };
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
    execute: async ({ label }) => ok({ label }),
});

/** Never stops asking for tools — only the tool-less wrap-up call ends the run. */
function neverTerminates(replyUsage: ChatUsage): ScriptedProvider {
    return scriptedProvider((callIndex, request) =>
        Object.keys(request.tools).length === 0
            ? makeMessage([textBlock("wrap-up")], "end_turn", replyUsage)
            : makeMessage([toolUseBlock(`tu-${callIndex}`, "echo", { label: "x" })], "tool_use", replyUsage),
    );
}

// ── One record per completed call ───────────────────────────────────

describe("runAgent usage records — one per completed call", () => {
    it("delivers a record for every call including the forced wrap-up", async () => {
        const { recorder, records } = recordingRecorder();

        await runAgent(agentDef([echoTool], 3), GO, makeSession(), opts(neverTerminates(usage(10, 2)), recorder));

        // 3 capped iterations + 1 forced wrap-up call.
        expect(records).toHaveLength(4);
        expect(records.every((r) => r.usage.inputTokens === 10)).toBe(true);
    });

    it("carries the session attribution and both model ids on each record", async () => {
        const { recorder, records } = recordingRecorder();
        const provider = scriptedProvider([
            { ...makeMessage([textBlock("done")], "end_turn", usage(11, 3)), requestedModelId: "asked-for", servedModelId: "answered-with" },
        ]);

        await runAgent(agentDef([]), GO, runFramedSession(), opts(provider, recorder));

        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
            agentId: "conversation-agent",
            callPath: ["conversation-agent"],
            scope: { kind: "analysis", analysisId: "analysis-001" },
            runId: "run-1",
            stepId: "step-a",
            requestedModelId: "asked-for",
            servedModelId: "answered-with",
            usage: { inputTokens: 11, outputTokens: 3 },
        });
    });

    it("leaves unreported attribution absent rather than undefined-valued", async () => {
        const { recorder, records } = recordingRecorder();
        const provider = scriptedProvider([makeMessage([textBlock("done")], "end_turn", usage(4, 1))]);

        // A `RequestSession` — no RunFrame, and the provider reported no model ids.
        await runAgent(agentDef([]), GO, makeSession(), opts(provider, recorder));

        const record = records[0]!;
        expect("runId" in record).toBe(false);
        expect("stepId" in record).toBe(false);
        expect("requestedModelId" in record).toBe(false);
        expect("servedModelId" in record).toBe(false);
    });

    it("produces no record for a call that reported nothing", async () => {
        const { recorder, records } = recordingRecorder();
        const provider = scriptedProvider([makeMessage([textBlock("done")], "end_turn")]);

        const { finish } = await runAgent(agentDef([]), GO, makeSession(), opts(provider, recorder));

        expect(records).toHaveLength(0);
        expect(finish.usage).toBeUndefined();
        expect(finish.turnUsage).toBeUndefined();
    });

    it("produces no record when a reply carries model ids but no usage figures", async () => {
        const { recorder, records } = recordingRecorder();
        const provider = scriptedProvider([
            // The shape a provider that reports identity but no accounting yields:
            // every usage field present as a key, none of them reported.
            {
                ...makeMessage([textBlock("done")], "end_turn", {
                    inputTokens: undefined,
                    outputTokens: undefined,
                    cacheCreationInputTokens: undefined,
                    cacheReadInputTokens: undefined,
                    reasoningTokens: undefined,
                }),
                requestedModelId: "asked-for",
                servedModelId: "answered-with",
            },
        ]);

        await runAgent(agentDef([]), GO, makeSession(), opts(provider, recorder));

        expect(records).toHaveLength(0);
    });

    it("records a call that reported usage without a cache breakdown, leaving the rest absent", async () => {
        const { recorder, records } = recordingRecorder();
        const provider = scriptedProvider([makeMessage([textBlock("done")], "end_turn", { inputTokens: 7 })]);

        await runAgent(agentDef([]), GO, makeSession(), opts(provider, recorder));

        expect(records[0]!.usage).toEqual({ inputTokens: 7 });
    });
});

// ── Delivery precedes termination ───────────────────────────────────

describe("runAgent usage records — delivered as calls complete", () => {
    it("has already delivered the earlier calls when a later call fails fatally", async () => {
        const { recorder, records } = recordingRecorder();
        const calls: ChatRequest[] = [];
        const provider: ChatProvider = {
            capabilities: { toolCalling: true },
            chat: (request) => {
                const i = calls.length;
                calls.push(request);
                if (i === 2) return errAsync({ type: "provider", retryable: false, message: "upstream exploded" });
                return okAsync(makeMessage([toolUseBlock(`tu-${i}`, "echo", { label: "x" })], "tool_use", usage(10, 2)));
            },
            chatStream: (): AsyncIterable<ChatStreamEvent> => {
                throw new Error("unused");
            },
        };

        await expect(runAgent(agentDef([echoTool]), GO, makeSession(), opts(provider, recorder))).rejects.toThrow(/upstream exploded/);

        // The two calls that completed before the fatal third are in the ledger.
        expect(records).toHaveLength(2);
    });

    it("records an aborted reply that reported usage", async () => {
        const { recorder, records } = recordingRecorder();
        const aborted: ChatResponse = {
            message: { role: "assistant", content: "a partial the user cut off" },
            finishReason: "aborted",
            usage: usage(9, 4),
        };
        const provider = scriptedProvider([aborted]);

        const { finish } = await runAgent(agentDef([]), GO, makeSession(), opts(provider, recorder));

        expect(finish.reason).toBe("aborted");
        expect(records).toHaveLength(1);
        expect(records[0]!.usage).toEqual({ inputTokens: 9, outputTokens: 4 });
        // The aborted call's tokens are in the rollup too — the fold precedes the abort branch.
        expect(finish.usage).toEqual({ inputTokens: 9, outputTokens: 4 });
    });
});

// ── Record keys ─────────────────────────────────────────────────────

describe("runAgent usage records — replay-safe keys", () => {
    /** Two calls: a tool round, then a terminal reply. */
    const twoCallScript = (): ScriptedProvider =>
        scriptedProvider([
            makeMessage([toolUseBlock("tu-fixed", "echo", { label: "x" })], "tool_use", usage(10, 2)),
            makeMessage([textBlock("done")], "end_turn", usage(5, 1)),
        ]);

    it("composes the identical keys from runId, stepId, call path and step name across two identical runs", async () => {
        const first = recordingRecorder();
        await runAgent(agentDef([echoTool]), GO, runFramedSession(), opts(twoCallScript(), first.recorder));

        const second = recordingRecorder();
        await runAgent(agentDef([echoTool]), GO, runFramedSession(), opts(twoCallScript(), second.recorder));

        // The loop's own deterministic step names, discriminated by the frame and
        // the call path — not a second numbering scheme that could drift from the
        // durable one.
        expect(first.records.map((r) => r.recordKey)).toEqual(["run-1:step-a:conversation-agent:llm-0", "run-1:step-a:conversation-agent:llm-1"]);
        expect(second.records.map((r) => r.recordKey)).toEqual(first.records.map((r) => r.recordKey));
    });

    it("keeps two steps of one run disjoint despite identical step names", async () => {
        // Sibling step workflows share the runId and each name their first LLM
        // call `llm-0`; only the stepId tells the two calls apart, and without
        // it an upserting sink would count them as one.
        const stepA = recordingRecorder();
        await runAgent(agentDef([echoTool]), GO, runFramedSession("step-a"), opts(twoCallScript(), stepA.recorder));

        const stepB = recordingRecorder();
        await runAgent(agentDef([echoTool]), GO, runFramedSession("step-b"), opts(twoCallScript(), stepB.recorder));

        const keysA = stepA.records.map((r) => r.recordKey);
        const keysB = stepB.records.map((r) => r.recordKey);
        expect(keysA).toEqual(["run-1:step-a:conversation-agent:llm-0", "run-1:step-a:conversation-agent:llm-1"]);
        expect(keysB).toEqual(["run-1:step-b:conversation-agent:llm-0", "run-1:step-b:conversation-agent:llm-1"]);
        expect(keysA.filter((k) => keysB.includes(k))).toEqual([]);
    });

    it("keeps sibling loops sharing one frame disjoint despite identical loop-local step names", async () => {
        // The post-step describer and the summary writer run under the SAME
        // `{runId, stepId}`, and each restarts its names at `llm-0`; the
        // provenance call path is the only thing that separates them.
        const frame = runFramedSession();

        const describer = recordingRecorder();
        await runAgent(agentDef([echoTool], 8, "file-describer"), GO, forSubAgent(frame, "file-describer"), opts(twoCallScript(), describer.recorder));

        const writer = recordingRecorder();
        await runAgent(agentDef([echoTool], 8, "step-summary-writer"), GO, forSubAgent(frame, "step-summary-writer"), opts(twoCallScript(), writer.recorder));

        const describerKeys = describer.records.map((r) => r.recordKey);
        const writerKeys = writer.records.map((r) => r.recordKey);
        expect(describerKeys).toEqual(["run-1:step-a:conversation-agent>file-describer:llm-0", "run-1:step-a:conversation-agent>file-describer:llm-1"]);
        expect(writerKeys).toEqual(["run-1:step-a:conversation-agent>step-summary-writer:llm-0", "run-1:step-a:conversation-agent>step-summary-writer:llm-1"]);
        expect(describerKeys.filter((k) => writerKeys.includes(k))).toEqual([]);
    });

    it("drops the stepId segment for a frame that carries none", async () => {
        const { recorder, records } = recordingRecorder();

        await runAgent(agentDef([echoTool]), GO, parentFramedSession(), opts(twoCallScript(), recorder));

        // The parent workflow's loops collide with nothing — their keys are one
        // segment shorter than any step's.
        expect(records.map((r) => r.recordKey)).toEqual(["run-1:conversation-agent:llm-0", "run-1:conversation-agent:llm-1"]);
        expect(records[0]!.stepId).toBeUndefined();
    });

    it("reuses a host's own step-name scheme verbatim", async () => {
        const { recorder, records } = recordingRecorder();
        const provider = scriptedProvider([makeMessage([textBlock("done")], "end_turn", usage(3, 1))]);

        await runAgent(
            agentDef([]),
            GO,
            runFramedSession(),
            opts(provider, recorder, {
                formatStepName: { llm: (i) => `llm:${i}`, tool: (name, id) => `tool:${name}:${id}` },
            }),
        );

        expect(records[0]!.recordKey).toBe("run-1:step-a:conversation-agent:llm:0");
    });

    it("mints a distinct key per call outside a RunFrame", async () => {
        const { recorder, records } = recordingRecorder();
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-1", "echo", { label: "x" })], "tool_use", usage(10, 2)),
            makeMessage([textBlock("done")], "end_turn", usage(5, 1)),
        ]);

        await runAgent(agentDef([echoTool]), GO, makeSession(), opts(provider, recorder));

        const keys = records.map((r) => r.recordKey);
        expect(keys).toHaveLength(2);
        expect(new Set(keys).size).toBe(2);
    });

    it("re-delivers the same keys on a replay whose steps are all served from the cache", async () => {
        // The durability semantic this capability rests on: a replayed body
        // re-executes while every completed step returns its cached value. A
        // caching `runStep` is what reproduces it — `passthroughStep` re-runs the
        // provider and so cannot tell record delivery inside the durable step
        // from delivery around it.
        const step = cachingStep();
        let providerCalls = 0;
        const provider = scriptedProvider((callIndex) => {
            providerCalls++;
            return callIndex === 0
                ? makeMessage([toolUseBlock("tu-fixed", "echo", { label: "x" })], "tool_use", usage(10, 2))
                : makeMessage([textBlock("done")], "end_turn", usage(5, 1));
        });

        const first = recordingRecorder();
        await runAgent(agentDef([echoTool]), GO, runFramedSession(), opts(provider, first.recorder, { runStep: step.runStep }));
        const callsAfterFirst = providerCalls;

        const replay = recordingRecorder();
        await runAgent(agentDef([echoTool]), GO, runFramedSession(), opts(provider, replay.recorder, { runStep: step.runStep }));

        // Nothing reached the wire the second time — every LLM and tool step was
        // served from the cache, exactly as a DBOS replay serves them.
        expect(providerCalls).toBe(callsAfterFirst);
        expect(provider.calls).toHaveLength(callsAfterFirst);
        // Yet the records fired again, with the identical keys: delivery sits
        // outside the durable step, so an upserting sink counts each call once.
        expect(first.records.map((r) => r.recordKey)).toEqual(["run-1:step-a:conversation-agent:llm-0", "run-1:step-a:conversation-agent:llm-1"]);
        expect(replay.records.map((r) => r.recordKey)).toEqual(first.records.map((r) => r.recordKey));
        expect(replay.records.map((r) => r.usage)).toEqual(first.records.map((r) => r.usage));
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
        execute: async (_input, ctx) => {
            const result = await runAgent(child, [{ role: "user", content: "child go" }], forSubAgent(ctx.session, "child-agent"), {
                provider: childProvider,
                signal: ctx.signal,
                emit: ctx.emit,
                runStep: passthroughStep,
                usageRecorder: recorder,
                turnUsage: ctx.turnUsage,
                invocationId: ctx.invocationId,
            });
            capture.finish = result.finish;
            return ok({ delegated: true });
        },
    });
}

describe("runAgent usage — sub-agent runs", () => {
    it("records the child's calls under the child agentId and extended callPath", async () => {
        const { recorder, records } = recordingRecorder();
        const capture: { finish?: AgentFinish } = {};
        const parent = scriptedProvider([
            makeMessage([toolUseBlock("tu-1", "delegate", {})], "tool_use", usage(10, 2)),
            makeMessage([textBlock("done")], "end_turn", usage(5, 1)),
        ]);
        const child = scriptedProvider([makeMessage([textBlock("child done")], "end_turn", usage(100, 20))]);

        await runAgent(agentDef([delegateTool(child, recorder, capture)]), GO, makeSession(), opts(parent, recorder));

        const childRecords = records.filter((r) => r.agentId === "child-agent");
        expect(childRecords).toHaveLength(1);
        expect(childRecords[0]!.callPath).toEqual(["conversation-agent", "child-agent"]);
        expect(childRecords[0]!.usage).toEqual({ inputTokens: 100, outputTokens: 20 });

        // The parent's own calls stay under the parent — the ledger spans the tree.
        expect(records.filter((r) => r.agentId === "conversation-agent")).toHaveLength(2);
    });

    it("totals the whole turn on the root finish while the child reports only its own", async () => {
        const { recorder } = recordingRecorder();
        const capture: { finish?: AgentFinish } = {};
        const parent = scriptedProvider([
            makeMessage([toolUseBlock("tu-1", "delegate", {})], "tool_use", usage(10, 2)),
            makeMessage([textBlock("done")], "end_turn", usage(5, 1)),
        ]);
        const child = scriptedProvider([makeMessage([textBlock("child done")], "end_turn", usage(100, 20))]);

        const { finish } = await runAgent(agentDef([delegateTool(child, recorder, capture)]), GO, makeSession(), opts(parent, recorder));

        expect(finish.usage).toEqual({ inputTokens: 15, outputTokens: 3 });
        expect(finish.turnUsage).toEqual({ inputTokens: 115, outputTokens: 23 });

        // The child created no accumulator, so it is not the root and reports no turn total.
        expect(capture.finish!.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
        expect(capture.finish!.turnUsage).toBeUndefined();
    });

    it("keeps parallel invocations of one sub-agent disjoint", async () => {
        // Both child loops run under the same frame, under the same call path,
        // and name their first call `llm-0`; the dispatching tool-call id is the
        // only thing left to tell them apart.
        const { recorder, records } = recordingRecorder();
        const capture: { finish?: AgentFinish } = {};
        const parent = scriptedProvider([
            makeMessage([toolUseBlock("tu-a", "delegate", {}), toolUseBlock("tu-b", "delegate", {})], "tool_use", usage(10, 2)),
            makeMessage([textBlock("done")], "end_turn", usage(5, 1)),
        ]);
        const child = scriptedProvider(() => makeMessage([textBlock("child done")], "end_turn", usage(100, 20)));

        await runAgent(agentDef([delegateTool(child, recorder, capture)]), GO, runFramedSession(), opts(parent, recorder));

        const childKeys = records.filter((r) => r.agentId === "child-agent").map((r) => r.recordKey);
        expect(childKeys).toHaveLength(2);
        expect(new Set(childKeys)).toEqual(
            new Set(["run-1:step-a:conversation-agent>child-agent:tu-a:llm-0", "run-1:step-a:conversation-agent>child-agent:tu-b:llm-0"]),
        );
    });

    it("threads the deps bag and the turn accumulator through a real sub-agent factory", async () => {
        // The tests above drive a stand-in tool written here, which proves the loop
        // honours what a tool passes down but not that any shipped factory passes
        // it. `createLiteratureReviewerTool` is the lightest real one — a provider,
        // a model label, and empty API keys — so it is what pins the wiring the
        // factories actually carry: the recorder from its deps, `ctx.turnUsage`,
        // and `ctx.invocationId`.
        const { recorder, records } = recordingRecorder();
        const childProvider = scriptedProvider([makeMessage([textBlock("evidence report")], "end_turn", usage(100, 20))]);
        const reviewer = createLiteratureReviewerTool({
            provider: childProvider,
            model: "claude-test",
            bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
            citationResolver: unusedCitationResolver,
            usageRecorder: recorder,
        });
        const parent = scriptedProvider([
            makeMessage([toolUseBlock("tu-lit", "literature_reviewer", { brief: "profile these genes" })], "tool_use", usage(10, 2)),
            makeMessage([textBlock("done")], "end_turn", usage(5, 1)),
        ]);

        const { finish } = await runAgent(agentDef([reviewer]), GO, runFramedSession(), opts(parent, recorder));

        const childRecords = records.filter((r) => r.agentId === "literature-reviewer");
        expect(childRecords).toHaveLength(1);
        expect(childRecords[0]!.callPath).toEqual(["conversation-agent", "literature-reviewer"]);
        expect(childRecords[0]!.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
        // The dispatching tool call's id rides in the key — the discriminator that
        // only reaches the child because the factory forwards `ctx.invocationId`.
        expect(childRecords[0]!.recordKey).toBe("run-1:step-a:conversation-agent>literature-reviewer:tu-lit:llm-0");

        // The child folded into the root's accumulator rather than a private one.
        expect(finish.usage).toEqual({ inputTokens: 15, outputTokens: 3 });
        expect(finish.turnUsage).toEqual({ inputTokens: 115, outputTokens: 23 });
    });

    it("reports no turn total when the caller supplied the accumulator", async () => {
        const { recorder } = recordingRecorder();
        const provider = scriptedProvider([makeMessage([textBlock("done")], "end_turn", usage(5, 1))]);
        const inherited = {};

        const { finish } = await runAgent(agentDef([]), GO, makeSession(), opts(provider, recorder, { turnUsage: inherited }));

        expect(finish.usage).toEqual({ inputTokens: 5, outputTokens: 1 });
        expect(finish.turnUsage).toBeUndefined();
        // The caller's accumulator carries the run's tokens for whoever owns it.
        expect(inherited).toEqual({ inputTokens: 5, outputTokens: 1 });
    });
});

// ── Rollups over the whole run ──────────────────────────────────────

describe("runAgent usage — finish rollups", () => {
    it("sums every call including the forced wrap-up", async () => {
        const { recorder } = recordingRecorder();

        const { finish } = await runAgent(agentDef([echoTool], 3), GO, makeSession(), opts(neverTerminates(usage(10, 2)), recorder));

        expect(finish.cappedOut).toBe(true);
        expect(finish.usage).toEqual({ inputTokens: 40, outputTokens: 8 });
        expect(finish.turnUsage).toEqual({ inputTokens: 40, outputTokens: 8 });
    });

    it("carries reasoning tokens through the fold when reported", async () => {
        const { recorder } = recordingRecorder();
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-1", "echo", { label: "x" })], "tool_use", { inputTokens: 10, outputTokens: 4, reasoningTokens: 3 }),
            makeMessage([textBlock("done")], "end_turn", { inputTokens: 5, outputTokens: 2 }),
        ]);

        const { finish } = await runAgent(agentDef([echoTool]), GO, makeSession(), opts(provider, recorder));

        expect(finish.usage).toEqual({ inputTokens: 15, outputTokens: 6, reasoningTokens: 3 });
    });

    it("leaves both rollups absent when no call reported usage", async () => {
        const { recorder, records } = recordingRecorder();

        const { finish } = await runAgent(agentDef([echoTool], 3), GO, makeSession(), opts(neverTerminates({}), recorder));

        expect(records).toHaveLength(0);
        expect(finish.usage).toBeUndefined();
        expect(finish.turnUsage).toBeUndefined();
    });
});
