import { describe, expect, it } from "bun:test";
import type { ModelMessage, ToolResultPart } from "ai";
import { err, errAsync, ok, okAsync } from "neverthrow";
import { z } from "zod";

import { createCapturingLogger } from "../__tests__/setup/logger.js";
import type { AgentSession } from "../auth/types.js";
import type { LlmUsageRecord } from "../billing/usage-recorder.js";
import { unwrapOrThrow } from "../lib/result.js";
import {
    compactionExchangeOf,
    compactionMarkerOf,
    contextRecordMessage,
    isInterruptedMessage,
    isSyntheticUserMessage,
    syntheticRecordMessage,
} from "../memory/ai-sdk-message-storage.js";
import { NOT_RUN_TOOL_RESULT } from "../memory/tool-call-integrity.js";
import { makeSession } from "../providers/__fixtures__/session.js";
import type { ProviderError } from "../providers/errors.js";
import type { AgentChat, ChatRequest, ChatResponse, ChatUsage } from "../providers/types.js";
import { AskRejectedError } from "../tools/approval/contract.js";
import { defineTool, withToolResultImage, withToolResultImages, type Tool } from "../tools/define-tool.js";
import {
    isWrapUpRequest,
    makeMessage,
    scriptedProvider,
    type ScriptedProvider,
    textBlock,
    thinkingBlock,
    toolUseBlock,
} from "./__fixtures__/scripted-provider.js";
import { COMPACTION_MAX_REQUESTS, type CompactionPolicy } from "./compaction.js";
import { continueAgent } from "./continue-agent.js";
import { runAgent, WRAP_UP_REQUEST, type AgentRound, type RunAgentOptions } from "./run-agent.js";
import { passthroughStep } from "./run-step.js";
import type { AgentDefinition, EmitEvent, EmitFn, LoopMessage, RunStep } from "./types.js";

// ── Harness helpers ─────────────────────────────────────────────────

function agentDef(tools: Tool[], maxIterations = 8): AgentDefinition {
    return {
        id: "test-agent",
        systemPrompt: "You are a test agent.",
        model: "claude-test",
        tools,
        maxIterations,
    };
}

const GO: ReadonlyArray<{ role: "user"; content: string }> = [{ role: "user", content: "go" }];

function opts(provider: ScriptedProvider, overrides: Partial<RunAgentOptions> = {}): RunAgentOptions {
    return {
        provider,
        signal: new AbortController().signal,
        emit: () => {},
        runStep: passthroughStep,
        ...overrides,
    };
}

/** A `RunStep` that records every step name it is asked to wrap. */
function recordingStep(): { runStep: RunStep; names: string[] } {
    const names: string[] = [];
    const runStep: RunStep = (name, fn) => {
        names.push(name);
        return fn();
    };
    return { runStep, names };
}

function toolResultParts(message: ModelMessage | undefined): ToolResultPart[] {
    expect(message).toBeDefined();
    expect(message!.role).toBe("tool");
    expect(Array.isArray(message!.content)).toBe(true);
    return message!.content as ToolResultPart[];
}

function outputValue(result: ToolResultPart): unknown {
    return result.output.type === "json" || result.output.type === "text" || result.output.type === "error-text" ? result.output.value : result.output;
}

function isErrorResult(result: ToolResultPart): boolean {
    return result.output.type === "error-text" || result.output.type === "error-json" || result.output.type === "execution-denied";
}

/** An `echo` tool whose `execute` optionally waits `ms` then returns the label. */
function echoTool(): Tool {
    return defineTool({
        id: "echo",
        description: "Echo the label back after an optional delay.",
        inputSchema: z.object({
            label: z.string(),
            ms: z.number().default(0),
        }),
        describeCall: "none",
        execute: async ({ label, ms }) => {
            if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
            return ok({ label });
        },
    });
}

// ── 5.1 — signed provider metadata round-trip (invariant 1) ──────────

describe("runAgent — invariant 1: provider metadata", () => {
    it("round-trips signed reasoning provider metadata byte-for-byte", async () => {
        const provider = scriptedProvider([makeMessage([thinkingBlock("let me reason", "SIG-abc-123"), textBlock("answer")], "end_turn")]);

        const { messages } = await runAgent(agentDef([]), GO, makeSession(), opts(provider));

        const assistant = messages.at(-1)!;
        expect(assistant.role).toBe("assistant");
        const content = assistant.content as Exclude<Extract<ModelMessage, { role: "assistant" }>["content"], string>;
        const reasoning = content.find((b) => b.type === "reasoning");
        expect(reasoning).toMatchObject({
            type: "reasoning",
            text: "let me reason",
            providerOptions: { anthropic: { signature: "SIG-abc-123" } },
        });
    });
});

// ── 5.2 — tool-result placement (invariant 2) ───────────────────────

describe("runAgent — invariant 2: tool-results in one tool message", () => {
    it("places N tool-result parts in exactly one tool message", async () => {
        const provider = scriptedProvider([
            makeMessage(
                [toolUseBlock("tu-1", "echo", { label: "a" }), toolUseBlock("tu-2", "echo", { label: "b" }), toolUseBlock("tu-3", "echo", { label: "c" })],
                "tool_use",
            ),
            makeMessage([textBlock("all done")], "end_turn"),
        ]);

        const { messages } = await runAgent(agentDef([echoTool()]), GO, makeSession(), opts(provider));

        // [user, assistant(3 tool-call), tool(3 tool-result), assistant(text)]
        expect(messages).toHaveLength(4);
        const blocks = toolResultParts(messages[2]);
        expect(blocks).toHaveLength(3);
        expect(blocks.every((b) => b.type === "tool-result")).toBe(true);
    });
});

// ── 5.3 — parallel association (invariant 3) ────────────────────────

describe("runAgent — invariant 3: tool-result association", () => {
    it("assembles results in [A,B,C] even when they resolve C,B,A", async () => {
        const provider = scriptedProvider([
            makeMessage(
                [
                    toolUseBlock("tu-A", "echo", { label: "A", ms: 30 }),
                    toolUseBlock("tu-B", "echo", { label: "B", ms: 15 }),
                    toolUseBlock("tu-C", "echo", { label: "C", ms: 1 }),
                ],
                "tool_use",
            ),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        const { messages } = await runAgent(agentDef([echoTool()]), GO, makeSession(), opts(provider));

        const blocks = toolResultParts(messages[2]);
        expect(blocks.map((b) => b.toolCallId)).toEqual(["tu-A", "tu-B", "tu-C"]);
    });
});

// ── 5.4 — append-only (invariant 4) ─────────────────────────────────

describe("runAgent — invariant 4: append-only message array", () => {
    it("never mutates prior messages and preserves their identity", async () => {
        const u0 = Object.freeze({ role: "user" as const, content: "go" });
        const initial = Object.freeze([u0]);
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-1", "echo", { label: "x" })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        const { messages } = await runAgent(agentDef([echoTool()]), initial, makeSession(), opts(provider));

        expect(messages).not.toBe(initial);
        // The initial message survives by reference — frozen, so any mutation
        // attempt inside the loop would have thrown.
        expect(messages[0]).toBe(u0);
        expect(messages[0]).toEqual({ role: "user", content: "go" });
        expect(messages.length).toBeGreaterThan(initial.length);
    });
});

// ── 5.5 — step-name determinism ─────────────────────────────────────

describe("runAgent — deterministic step names", () => {
    function buildProvider(): ScriptedProvider {
        return scriptedProvider([makeMessage([toolUseBlock("tu-fixed-1", "echo", { label: "x" })], "tool_use"), makeMessage([textBlock("done")], "end_turn")]);
    }

    it("emits the identical step-name sequence over identical inputs", async () => {
        const first = recordingStep();
        await runAgent(agentDef([echoTool()]), GO, makeSession(), opts(buildProvider(), { runStep: first.runStep }));

        const second = recordingStep();
        await runAgent(agentDef([echoTool()]), GO, makeSession(), opts(buildProvider(), { runStep: second.runStep }));

        expect(first.names).toEqual(["llm-0", "tool-echo-tu-fixed-1", "llm-1"]);
        expect(second.names).toEqual(first.names);
    });
});

describe("runAgent — provider capability gate", () => {
    it("rejects tool-required agents before the first model call when tool calling is unavailable", async () => {
        const provider: ScriptedProvider = {
            ...scriptedProvider([makeMessage([textBlock("should not be called")], "end_turn")]),
            capabilities: { toolCalling: false },
        };

        await expect(runAgent(agentDef([echoTool()]), GO, makeSession(), opts(provider))).rejects.toThrow(/cannot run tool-required agent/);
        expect(provider.calls).toHaveLength(0);
    });
});

// ── executionMode partition (see the harness-tools spec) ─────────────

describe("runAgent — workflow tools run unwrapped, in order", () => {
    function workflowTool(): Tool {
        return defineTool({
            id: "workflow",
            description: "A workflow-backed tool.",
            executionMode: "workflow",
            inputSchema: z.object({ label: z.string() }),
            describeCall: "none",
            execute: async ({ label }) => ok({ label }),
        });
    }

    it("dispatches a workflow tool without a runStep wrap; step tools still wrapped", async () => {
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-w", "echo", { label: "w" }), toolUseBlock("tu-b", "workflow", { label: "b" })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        const rec = recordingStep();
        const { messages } = await runAgent(agentDef([echoTool(), workflowTool()]), GO, makeSession(), opts(provider, { runStep: rec.runStep }));

        expect(rec.names).toEqual(["llm-0", "tool-echo-tu-w", "llm-1"]);

        // Results are assembled by original index regardless of execution order.
        const blocks = toolResultParts(messages[2]);
        expect(blocks.map((b) => b.toolCallId)).toEqual(["tu-w", "tu-b"]);
        expect(outputValue(blocks[1]!)).toEqual({ label: "b" });
    });
});

// ── 5.6 — max-iteration wrap-up ─────────────────────────────────────

describe("runAgent — max-iteration wrap-up", () => {
    /** A counting echo tool, thus a test can see that the wrap-up ran no tool. */
    function countedEcho(): { tool: Tool; runs: () => number } {
        let count = 0;
        const tool = defineTool({
            id: "echo",
            description: "Echo the label back.",
            inputSchema: z.object({ label: z.string() }),
            describeCall: "none",
            execute: async ({ label }) => {
                count++;
                return ok({ label });
            },
        });
        return { tool, runs: () => count };
    }

    const toolCall = (callIndex: number): ChatResponse => makeMessage([toolUseBlock(`tu-${callIndex}`, "echo", { label: "x" })], "tool_use");

    it("wraps up at the cap with the tools and the tool choice of the loop, and returns without throwing", async () => {
        const provider = scriptedProvider((callIndex, request) =>
            isWrapUpRequest(request) ? makeMessage([textBlock("here is where I reached")], "end_turn") : toolCall(callIndex),
        );
        const rec = recordingStep();

        const { messages, finish } = await runAgent(agentDef([echoTool()], 3), GO, makeSession(), opts(provider, { runStep: rec.runStep, toolChoice: "auto" }));

        // 3 capped iterations + 1 wrap-up request.
        expect(provider.calls).toHaveLength(4);
        expect(provider.calls.map((call) => call.toolChoice)).toEqual(["auto", "auto", "auto", "auto"]);
        expect(Object.keys(provider.calls[3]!.tools)).toEqual(Object.keys(provider.calls[2]!.tools));
        // The first wrap-up request keeps the step name of the single wrap-up call of an earlier version.
        expect(rec.names.filter((name) => name.startsWith("llm-"))).toEqual(["llm-0", "llm-1", "llm-2", "llm-3"]);

        // The wrap-up request is a synthetic user message, thus it opens no turn.
        const wrapUpRequest = messages.at(-2)!;
        expect(isSyntheticUserMessage(wrapUpRequest)).toBe(true);
        expect(wrapUpRequest.content).toBe(WRAP_UP_REQUEST);
        const last = messages.at(-1)!;
        expect(last.role).toBe("assistant");
        const content = last.content as Exclude<Extract<ModelMessage, { role: "assistant" }>["content"], string>;
        expect(content.some((b) => b.type === "text" && b.text === "here is where I reached")).toBe(true);
        expect(finish).toMatchObject({ reason: "max_iterations", cappedOut: true });
    });

    it("refuses a call of the wrap-up and sends a second request", async () => {
        const { tool, runs } = countedEcho();
        const provider = scriptedProvider((callIndex) => (callIndex < 4 ? toolCall(callIndex) : makeMessage([textBlock("answer")], "end_turn")));

        const { messages, finish } = await runAgent(agentDef([tool], 3), GO, makeSession(), opts(provider));

        // 3 loop requests + 2 wrap-up requests; the call of the first wrap-up reply did not run.
        expect(provider.calls).toHaveLength(5);
        expect(runs()).toBe(3);
        const refused = toolResultParts(messages.at(-2))[0]!;
        expect(refused.toolCallId).toBe("tu-3");
        expect(String(outputValue(refused))).toContain("No tool can run for this request");
        expect(messages.at(-1)!.content).toEqual([{ type: "text", text: "answer" }]);
        expect(finish).toMatchObject({ reason: "max_iterations", cappedOut: true });
    });

    it("ends after 2 wrap-up requests when the model calls a tool in each reply", async () => {
        const { tool, runs } = countedEcho();
        const provider = scriptedProvider((callIndex) => toolCall(callIndex));
        const rec = recordingStep();
        const iterations: [number, boolean][] = [];

        const { messages, finish } = await runAgent(
            agentDef([tool], 3),
            GO,
            makeSession(),
            opts(provider, {
                runStep: rec.runStep,
                emit: (event) => {
                    if (event.type === "iteration") iterations.push([event.index, event.final]);
                },
            }),
        );

        expect(provider.calls).toHaveLength(5);
        expect(runs()).toBe(3);
        expect(rec.names.filter((name) => name.startsWith("llm-"))).toEqual(["llm-0", "llm-1", "llm-2", "llm-3", "llm-4"]);
        // Wrap-up request `k` has the index `maxIterations + k`, and the last one is final.
        expect(iterations).toEqual([
            [0, false],
            [1, false],
            [2, false],
            [3, false],
            [4, true],
        ]);
        // The transcript ends with the refusal of the second wrap-up reply, and no call lacks a result.
        expect(toolResultParts(messages.at(-1)).map((r) => [r.toolCallId, isErrorResult(r)])).toEqual([["tu-4", true]]);
        expect(provider.calls.every((call) => call.toolChoice === undefined)).toBe(true);
        expect(finish).toMatchObject({ reason: "max_iterations", cappedOut: true });
    });
});

// ── Tool-error boundary (spec scenarios) ────────────────────────────

describe("runAgent — tool-error boundary", () => {
    it("wraps a throwing tool as an is_error tool_result and continues", async () => {
        const boom = defineTool({
            id: "boom",
            description: "Always throws.",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: async () => {
                throw new Error("kaboom");
            },
        });
        const provider = scriptedProvider([makeMessage([toolUseBlock("tu-1", "boom", {})], "tool_use"), makeMessage([textBlock("recovered")], "end_turn")]);

        const { messages } = await runAgent(agentDef([boom]), GO, makeSession(), opts(provider));

        const result = toolResultParts(messages[2])[0]!;
        expect(isErrorResult(result)).toBe(true);
        expect(String(outputValue(result))).toContain("kaboom");
        expect(messages.at(-1)!.role).toBe("assistant");
    });

    it("unwraps an ok(value) Result into a non-error tool_result", async () => {
        const okTool = defineTool({
            id: "ok_tool",
            description: "Returns an ok Result.",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: async () => ok({ answer: 42 }),
        });
        const provider = scriptedProvider([makeMessage([toolUseBlock("tu-1", "ok_tool", {})], "tool_use"), makeMessage([textBlock("done")], "end_turn")]);

        const { messages } = await runAgent(agentDef([okTool]), GO, makeSession(), opts(provider));

        const result = toolResultParts(messages[2])[0]!;
        expect(isErrorResult(result)).toBe(false);
        expect(outputValue(result)).toEqual({ answer: 42 });
    });

    it("strips NUL from a tool result so the turn can be stored", async () => {
        // A NUL byte cannot survive the message store, and tool results are the one
        // message content built from raw command output and file bytes.
        const NUL = String.fromCharCode(0);
        const binary = defineTool({
            id: "binary_tool",
            description: "Returns bytes read off disk.",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: async () => ok({ header: `MAGIC${NUL}rest`, lines: [`a${NUL}b`] }),
        });
        const provider = scriptedProvider([makeMessage([toolUseBlock("tu-1", "binary_tool", {})], "tool_use"), makeMessage([textBlock("done")], "end_turn")]);

        const { messages } = await runAgent(agentDef([binary]), GO, makeSession(), opts(provider));

        const result = toolResultParts(messages[2])[0]!;
        expect(outputValue(result)).toEqual({ header: "MAGICrest", lines: ["ab"] });
        expect(JSON.stringify(messages)).not.toContain("\\u0000");
    });

    it("strips NUL from a thrown tool error's message", async () => {
        const NUL = String.fromCharCode(0);
        const noisy = defineTool({
            id: "noisy_tool",
            description: "Throws with stderr quoted verbatim.",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: async () => {
                throw new Error(`segfault${NUL} core dumped`);
            },
        });
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-1", "noisy_tool", {})], "tool_use"),
            makeMessage([textBlock("recovered")], "end_turn"),
        ]);

        const { messages } = await runAgent(agentDef([noisy]), GO, makeSession(), opts(provider));

        const result = toolResultParts(messages[2])[0]!;
        expect(isErrorResult(result)).toBe(true);
        expect(String(outputValue(result))).toContain("segfault core dumped");
        expect(JSON.stringify(messages)).not.toContain("\\u0000");
    });

    it("maps an err(ToolError) Result to an is_error tool_result verbatim", async () => {
        const errTool = defineTool({
            id: "err_tool",
            description: "Returns an err Result.",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: async () => err({ error: "upstream down", retryable: true } as const),
        });
        const provider = scriptedProvider([makeMessage([toolUseBlock("tu-1", "err_tool", {})], "tool_use"), makeMessage([textBlock("recovered")], "end_turn")]);

        const { messages } = await runAgent(agentDef([errTool]), GO, makeSession(), opts(provider));

        const result = toolResultParts(messages[2])[0]!;
        expect(isErrorResult(result)).toBe(true);
        expect(JSON.parse(String(outputValue(result)))).toEqual({
            error: "upstream down",
            retryable: true,
        });
    });

    it("maps a ToolError bridged through unwrapOrThrow to the same is_error tool_result as a returned err", async () => {
        const bridging = defineTool({
            id: "bridging_tool",
            description: "Bridges a ToolError through unwrapOrThrow.",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: async () => ok(unwrapOrThrow(err({ error: "sandbox refused the exec", retryable: false } as const))),
        });
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-1", "bridging_tool", {})], "tool_use"),
            makeMessage([textBlock("recovered")], "end_turn"),
        ]);

        const { messages } = await runAgent(agentDef([bridging]), GO, makeSession(), opts(provider));

        const result = toolResultParts(messages[2])[0]!;
        expect(isErrorResult(result)).toBe(true);
        expect(String(outputValue(result))).not.toContain("[object Object]");
        expect(JSON.parse(String(outputValue(result)))).toEqual({
            error: "sandbox refused the exec",
            retryable: false,
        });
    });

    it("rejects Zod-invalid tool input before execute runs", async () => {
        let executed = false;
        const strict = defineTool({
            id: "strict",
            description: "Needs a number.",
            inputSchema: z.object({ n: z.number() }),
            describeCall: "none",
            execute: async () => {
                executed = true;
                return ok({ ok: true });
            },
        });
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-1", "strict", { n: "not-a-number" })], "tool_use"),
            makeMessage([textBlock("ok")], "end_turn"),
        ]);

        const { messages } = await runAgent(agentDef([strict]), GO, makeSession(), opts(provider));

        expect(executed).toBe(false);
        const result = toolResultParts(messages[2])[0]!;
        expect(isErrorResult(result)).toBe(true);
        expect(String(outputValue(result))).toContain("input validation failed");
    });

    it("re-raises fatal workflow-backed errors instead of returning an error tool result", async () => {
        const fatal = new Error("workflow cancelled");
        const workflow = defineTool({
            id: "workflow_fatal",
            description: "Throws a fatal workflow error.",
            executionMode: "workflow",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: async () => {
                throw fatal;
            },
        });
        const provider = scriptedProvider([makeMessage([toolUseBlock("tu-1", "workflow_fatal", {})], "tool_use")]);

        await expect(
            runAgent(
                agentDef([workflow]),
                GO,
                makeSession(),
                opts(provider, {
                    isFatalLoopError: (err) => err === fatal,
                }),
            ),
        ).rejects.toBe(fatal);
    });

    it("always re-raises AbortError as cancellation control flow", async () => {
        const aborted = new DOMException("The operation was aborted", "AbortError");
        const tool = defineTool({
            id: "abort",
            description: "Aborts.",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: async () => {
                throw aborted;
            },
        });
        const provider = scriptedProvider([makeMessage([toolUseBlock("tu-1", "abort", {})], "tool_use")]);

        await expect(runAgent(agentDef([tool]), GO, makeSession(), opts(provider))).rejects.toBe(aborted);
    });
});

// ── A picture on a tool result ──────────────────────────────────────

/** A scripted provider whose wire carries a picture inside a tool result. */
function imagingProvider(script: ChatResponse[]): ScriptedProvider {
    return { ...scriptedProvider(script), capabilities: { toolCalling: true, imageToolResults: true } };
}

/** An `eyes` tool that returns a picture beside its JSON faults. */
function eyesTool(): Tool {
    return defineTool({
        id: "eyes",
        description: "Look at a page and give a picture beside the faults.",
        inputSchema: z.object({}),
        describeCall: "none",
        execute: async () => ok(withToolResultImage({ faults: ["boom"] }, { base64: "PNGBYTES", mediaType: "image/png" })),
    });
}

/** An `eyes` tool that returns two slices beside its JSON faults, in document order. */
function slicingEyesTool(): Tool {
    return defineTool({
        id: "eyes",
        description: "Look at a tall page and give its slices in document order.",
        inputSchema: z.object({}),
        describeCall: "none",
        execute: async () =>
            ok(
                withToolResultImages({ faults: ["boom"] }, [
                    { base64: "TILE-ONE", mediaType: "image/png" },
                    { base64: "TILE-TWO", mediaType: "image/png" },
                ]),
            ),
    });
}

describe("runAgent — a picture on a tool result", () => {
    it("splits a picture-bearing result into a JSON text part and an image part when the wire carries a picture", async () => {
        const provider = imagingProvider([makeMessage([toolUseBlock("tu-1", "eyes", {})], "tool_use"), makeMessage([textBlock("done")], "end_turn")]);

        const { messages } = await runAgent(agentDef([eyesTool()]), GO, makeSession(), opts(provider));

        const result = toolResultParts(messages[2])[0]!;
        expect(result.output.type).toBe("content");
        const parts = (result.output as { type: "content"; value: Array<{ type: string }> }).value;
        // The text part carries the faults, and it holds no bytes.
        const textPart = parts.find((p) => p.type === "text") as { type: "text"; text: string };
        expect(JSON.parse(textPart.text)).toEqual({ faults: ["boom"] });
        expect(textPart.text).not.toContain("PNGBYTES");
        // The file part carries the picture bytes and the media type.
        const filePart = parts.find((p) => p.type === "file") as { type: "file"; mediaType: string; data: unknown };
        expect(filePart.mediaType).toBe("image/png");
        expect(filePart.data).toEqual({ type: "data", data: "PNGBYTES" });
    });

    it("carries every slice of a multi-picture result on the tool result, in document order", async () => {
        const provider = imagingProvider([makeMessage([toolUseBlock("tu-1", "eyes", {})], "tool_use"), makeMessage([textBlock("done")], "end_turn")]);

        const { messages } = await runAgent(agentDef([slicingEyesTool()]), GO, makeSession(), opts(provider));

        const result = toolResultParts(messages[2])[0]!;
        expect(result.output).toEqual({
            type: "content",
            value: [
                { type: "text", text: JSON.stringify({ faults: ["boom"] }) },
                { type: "file", mediaType: "image/png", data: { type: "data", data: "TILE-ONE" } },
                { type: "file", mediaType: "image/png", data: { type: "data", data: "TILE-TWO" } },
            ],
        });
    });

    it("drops the picture and keeps the JSON text when the wire carries none, and records the drop", async () => {
        const logger = createCapturingLogger();
        // The default scripted provider states no picture capability, thus the wire carries none.
        const provider = scriptedProvider([makeMessage([toolUseBlock("tu-1", "eyes", {})], "tool_use"), makeMessage([textBlock("done")], "end_turn")]);

        const { messages } = await runAgent(agentDef([eyesTool()]), GO, makeSession(), opts(provider, { logger }));

        const result = toolResultParts(messages[2])[0]!;
        expect(result.output.type).toBe("json");
        expect(outputValue(result)).toEqual({ faults: ["boom"] });
        // No picture bytes reach the transcript.
        expect(JSON.stringify(messages)).not.toContain("PNGBYTES");
        // The wire renders a picture in no place at all, thus the loop appends no fallback message.
        expect(messages.filter((m) => m.role === "user")).toEqual([...GO]);
        // The drop rides the log, thus an operator sees that the picture did not reach the model.
        expect(logger.records.some((r) => r.level === "warn" && r.msg.includes("carries no picture"))).toBe(true);
    });

    it("drops every slice of a multi-picture result with one warn that carries the count", async () => {
        const logger = createCapturingLogger();
        // The default scripted provider states no picture capability, thus the wire carries none.
        const provider = scriptedProvider([makeMessage([toolUseBlock("tu-1", "eyes", {})], "tool_use"), makeMessage([textBlock("done")], "end_turn")]);

        const { messages } = await runAgent(agentDef([slicingEyesTool()]), GO, makeSession(), opts(provider, { logger }));

        const result = toolResultParts(messages[2])[0]!;
        expect(result.output).toEqual({ type: "json", value: { faults: ["boom"] } });
        expect(JSON.stringify(messages)).not.toContain("TILE-ONE");
        // One warn accounts for the whole result, and the count says how many pictures the model lost.
        const warns = logger.records.filter((r) => r.level === "warn" && r.msg.includes("carries no picture"));
        expect(warns).toHaveLength(1);
        expect(warns[0]!.fields["imageCount"]).toBe(2);
    });

    it("encodes a payload-free result as a plain JSON part, byte-identical to today", async () => {
        // The wire carries a picture, but the tool attaches none, thus the result is unchanged.
        const provider = imagingProvider([
            makeMessage([toolUseBlock("tu-1", "echo", { label: "x" })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        const { messages } = await runAgent(agentDef([echoTool()]), GO, makeSession(), opts(provider));

        const result = toolResultParts(messages[2])[0]!;
        expect(result.output).toEqual({ type: "json", value: { label: "x" } });
    });
});

// ── A picture on a user message ─────────────────────────────────────

/** A scripted provider whose wire renders a picture in a user message only. */
function fallbackImagingProvider(script: ChatResponse[]): ScriptedProvider {
    return { ...scriptedProvider(script), capabilities: { toolCalling: true, imageUserMessages: true } };
}

/** The content parts of a user message that carries a picture. */
function userParts(message: ModelMessage | undefined): unknown[] {
    expect(message).toBeDefined();
    expect(message!.role).toBe("user");
    expect(Array.isArray(message!.content)).toBe(true);
    return message!.content as unknown[];
}

/** The delay of the slow call of the batch case, in milliseconds. */
const SLOW_EYES_MS = 40;

/** An `eyes` tool whose picture bytes name the page. A delay of `ms` holds the reply back. */
function pagingEyesTool(): Tool {
    return defineTool({
        id: "eyes",
        description: "Look at one page and give a picture of it.",
        inputSchema: z.object({ page: z.string(), ms: z.number().default(0) }),
        describeCall: "none",
        execute: async ({ page, ms }) => {
            if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
            return ok(withToolResultImage({ page }, { base64: `BYTES-${page}`, mediaType: "image/png" }));
        },
    });
}

describe("runAgent — a picture on a user message", () => {
    it("keeps the JSON text on the tool result and carries the picture in the next user message", async () => {
        const provider = fallbackImagingProvider([makeMessage([toolUseBlock("tu-1", "eyes", {})], "tool_use"), makeMessage([textBlock("done")], "end_turn")]);

        const { messages } = await runAgent(agentDef([eyesTool()]), GO, makeSession(), opts(provider));

        // [user, assistant(tool-call), tool(result), user(picture), assistant(text)]
        expect(messages).toHaveLength(5);
        // The tool result stays plain JSON, thus the bytes ride the fallback message alone.
        const result = toolResultParts(messages[2])[0]!;
        expect(result.output).toEqual({ type: "json", value: { faults: ["boom"] } });
        // The text part names the tool call, because the wire holds no structural link to it.
        expect(userParts(messages[3])).toEqual([
            { type: "text", text: "The picture of the tool result tu-1 of eyes." },
            { type: "file", mediaType: "image/png", data: { type: "data", data: "PNGBYTES" } },
        ]);
    });

    it("carries every slice of a multi-picture result in the fallback message, with a numbered label on each", async () => {
        const provider = fallbackImagingProvider([makeMessage([toolUseBlock("tu-1", "eyes", {})], "tool_use"), makeMessage([textBlock("done")], "end_turn")]);

        const { messages } = await runAgent(agentDef([slicingEyesTool()]), GO, makeSession(), opts(provider));

        // [user, assistant(tool-call), tool(result), user(2 pictures), assistant(text)]
        expect(messages).toHaveLength(5);
        const result = toolResultParts(messages[2])[0]!;
        expect(result.output).toEqual({ type: "json", value: { faults: ["boom"] } });
        // The labels number the slices, thus the model reads which slice each picture is.
        expect(userParts(messages[3])).toEqual([
            { type: "text", text: "The picture 1 of 2 of the tool result tu-1 of eyes." },
            { type: "file", mediaType: "image/png", data: { type: "data", data: "TILE-ONE" } },
            { type: "text", text: "The picture 2 of 2 of the tool result tu-1 of eyes." },
            { type: "file", mediaType: "image/png", data: { type: "data", data: "TILE-TWO" } },
        ]);
    });

    it("batches the pictures of one round into one user message, in the order of the tool calls", async () => {
        // The slow call comes first, thus the two calls settle in the reverse order.
        // The message order comes from the tool calls, and not from the settle order.
        const provider = fallbackImagingProvider([
            makeMessage([toolUseBlock("tu-A", "eyes", { page: "first", ms: SLOW_EYES_MS }), toolUseBlock("tu-B", "eyes", { page: "second" })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        const { messages } = await runAgent(agentDef([pagingEyesTool()]), GO, makeSession(), opts(provider));

        // [user, assistant(2 tool-calls), tool(2 results), user(2 pictures), assistant(text)]
        expect(messages).toHaveLength(5);
        // One message batches the round, and it comes directly after the tool message.
        expect(messages[2]!.role).toBe("tool");
        expect(userParts(messages[3])).toEqual([
            { type: "text", text: "The picture of the tool result tu-A of eyes." },
            { type: "file", mediaType: "image/png", data: { type: "data", data: "BYTES-first" } },
            { type: "text", text: "The picture of the tool result tu-B of eyes." },
            { type: "file", mediaType: "image/png", data: { type: "data", data: "BYTES-second" } },
        ]);
    });

    it("carries the picture on the tool result alone when the wire renders it in both places", async () => {
        const provider: ScriptedProvider = {
            ...scriptedProvider([makeMessage([toolUseBlock("tu-1", "eyes", {})], "tool_use"), makeMessage([textBlock("done")], "end_turn")]),
            capabilities: { toolCalling: true, imageToolResults: true, imageUserMessages: true },
        };

        const { messages } = await runAgent(agentDef([eyesTool()]), GO, makeSession(), opts(provider));

        // [user, assistant(tool-call), tool(result), assistant(text)] — the fallback message is absent.
        expect(messages).toHaveLength(4);
        const result = toolResultParts(messages[2])[0]!;
        expect(result.output).toEqual({
            type: "content",
            value: [
                { type: "text", text: JSON.stringify({ faults: ["boom"] }) },
                { type: "file", mediaType: "image/png", data: { type: "data", data: "PNGBYTES" } },
            ],
        });
        // The tool-result path is exclusive, thus the opening prompt stays the one user message.
        expect(messages.filter((m) => m.role === "user")).toEqual([...GO]);
    });

    it("marks the fallback message synthetic, thus a turn-boundary reader passes over it", async () => {
        const provider = fallbackImagingProvider([makeMessage([toolUseBlock("tu-1", "eyes", {})], "tool_use"), makeMessage([textBlock("done")], "end_turn")]);

        const { messages } = await runAgent(agentDef([eyesTool()]), GO, makeSession(), opts(provider));

        // The message holds the `user` role because a picture rides no other role. An unmarked one
        // reads as a turn start, and it then splits one stored turn in two.
        const fallback = messages[3]!;
        expect(fallback.role).toBe("user");
        expect(isSyntheticUserMessage(fallback)).toBe(true);
        // The opening prompt is real user input, thus the one true boundary of the turn stays.
        expect(isSyntheticUserMessage(messages[0]!)).toBe(false);
    });

    it("carries the picture after the tool message of a round that the output limit cut", async () => {
        // The truncated round is the second dispatch path of the loop. It assembles its
        // own tool message, thus the fallback must land there too.
        const provider = fallbackImagingProvider([
            makeMessage([toolUseBlock("tu-1", "eyes", {}), toolUseBlock("tu-cut", "eyes", {})], "max_tokens"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        const { messages } = await runAgent(agentDef([eyesTool()]), GO, makeSession(), opts(provider));

        // [user, assistant(2 tool-calls), tool(2 results), user(picture), assistant(text)]
        expect(messages).toHaveLength(5);
        // The complete call gives its JSON result, and the trailing call gives the refusal.
        const results = toolResultParts(messages[2]);
        expect(results.map((r) => r.toolCallId)).toEqual(["tu-1", "tu-cut"]);
        expect(results[0]!.output).toEqual({ type: "json", value: { faults: ["boom"] } });
        expect(isErrorResult(results[1]!)).toBe(true);
        expect(String(outputValue(results[1]!))).toContain("cut off");
        // One fallback message trails the tool message, and it names the call that ran.
        const fallback = messages[3]!;
        expect(userParts(fallback)).toEqual([
            { type: "text", text: "The picture of the tool result tu-1 of eyes." },
            { type: "file", mediaType: "image/png", data: { type: "data", data: "PNGBYTES" } },
        ]);
        expect(isSyntheticUserMessage(fallback)).toBe(true);
    });
});

// ── max_tokens is a recoverable soft-error (see the harness-agent-loop spec) ───────────────

describe("runAgent — max_tokens recovery", () => {
    it("refuses a truncated trailing tool_use, feeds back a retryable error, and continues", async () => {
        let executed = false;
        const writer = defineTool({
            id: "writer",
            description: "Writes a payload.",
            inputSchema: z.object({ body: z.string() }),
            describeCall: "none",
            execute: async () => {
                executed = true;
                return ok({ ok: true });
            },
        });
        const provider = scriptedProvider([
            // Truncated at the output cap mid-tool-call.
            makeMessage([toolUseBlock("tu-cut", "writer", { body: "half a file" })], "max_tokens"),
            makeMessage([textBlock("recovered")], "end_turn"),
        ]);

        const { messages, finish } = await runAgent(agentDef([writer]), GO, makeSession(), opts(provider));

        // The truncated trailing tool_use was NOT dispatched.
        expect(executed).toBe(false);

        // A retryable is_error tool_result was synthesized for it, preserving the
        // tool_use↔tool_result pairing.
        const result = toolResultParts(messages[2])[0]!;
        expect(result.type).toBe("tool-result");
        expect(result.toolCallId).toBe("tu-cut");
        expect(isErrorResult(result)).toBe(true);
        expect(String(outputValue(result))).toContain("cut off");

        // The loop continued to a clean terminal reply and counted the recovery.
        expect(finish.reason).toBe("stop");
        expect(finish.truncationRecoveries).toBe(1);
        expect(messages.at(-1)!.role).toBe("assistant");
    });

    it("dispatches earlier complete tool_uses but refuses the truncated trailing one", async () => {
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-A", "echo", { label: "A" }), toolUseBlock("tu-B", "echo", { label: "B-cut" })], "max_tokens"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        const { messages } = await runAgent(agentDef([echoTool()]), GO, makeSession(), opts(provider));

        const blocks = toolResultParts(messages[2]);
        expect(blocks.map((b) => b.toolCallId)).toEqual(["tu-A", "tu-B"]);
        // The earlier tool ran (no error); the trailing one was refused.
        expect(isErrorResult(blocks[0]!)).toBe(false);
        expect(isErrorResult(blocks[1]!)).toBe(true);
    });

    it("steers and continues on truncated prose (no tool_use)", async () => {
        const provider = scriptedProvider([
            makeMessage([textBlock("a very long answer that got cut")], "max_tokens"),
            makeMessage([textBlock("finished")], "end_turn"),
        ]);

        const { messages, finish } = await runAgent(agentDef([]), GO, makeSession(), opts(provider));

        // [user, assistant(truncated), user(steer), assistant(finished)]
        expect(messages).toHaveLength(4);
        const steer = messages[2]!;
        expect(steer.role).toBe("user");
        expect(String(steer.content)).toContain("cut off");
        // The steer must be marked synthetic. It carries the `user` role only because the wire format
        // demands one after a truncated assistant message — a reader that took it for user input would
        // see a turn boundary in the middle of this turn, and a tail-turn removal would cut there.
        expect(isSyntheticUserMessage(steer)).toBe(true);
        // The opening prompt is real user input and must NOT be marked, or the boundary vanishes entirely.
        expect(isSyntheticUserMessage(messages[0]!)).toBe(false);
        expect(finish.reason).toBe("stop");
        expect(finish.truncationRecoveries).toBe(1);
    });
});

// ── tool mask and tool budget (see the harness-agent-loop spec) ─────

describe("runAgent — tool mask and budget", () => {
    /** A tool that counts each execution under its own id. */
    function countingTool(id: string, counts: Map<string, number>): Tool {
        return defineTool({
            id,
            description: `Counts each call of ${id}.`,
            inputSchema: z.object({ label: z.string() }),
            describeCall: "none",
            execute: async ({ label }) => {
                counts.set(id, (counts.get(id) ?? 0) + 1);
                return ok({ label });
            },
        });
    }

    it("refuses a call outside the mask, names the tool, and continues", async () => {
        const counts = new Map<string, number>();
        const events: EmitEvent[] = [];
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-w", "writer", { label: "w" }), toolUseBlock("tu-e", "echo", { label: "e" })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        const { messages, finish } = await runAgent(
            agentDef([countingTool("echo", counts), countingTool("writer", counts)]),
            GO,
            makeSession(),
            opts(provider, {
                toolMask: { allow: ["echo"] },
                emit: (event) => {
                    if ("source" in event && (event.type === "tool-started" || event.type === "tool-finished")) events.push(event);
                },
            }),
        );

        expect(counts.get("writer")).toBeUndefined();
        expect(counts.get("echo")).toBe(1);
        const [refused, ran] = toolResultParts(messages[2]);
        expect(refused!.toolCallId).toBe("tu-w");
        expect(isErrorResult(refused!)).toBe(true);
        expect(String(outputValue(refused!))).toContain("writer is not available for this request");
        expect(isErrorResult(ran!)).toBe(false);
        // Each request still declares both tools: the mask limits what runs, not the prefix.
        expect(provider.calls.map((call) => Object.keys(call.tools))).toEqual([
            ["echo", "writer"],
            ["echo", "writer"],
        ]);
        // The refused call keeps its started and finished pair, reported as an error.
        expect(events.filter((e) => e.type === "tool-finished" && e.toolUseId === "tu-w").map((e) => e.type === "tool-finished" && e.outcome)).toEqual([
            "error",
        ]);
        expect(events.some((e) => e.type === "tool-started" && e.toolUseId === "tu-w")).toBe(true);
        expect(finish.reason).toBe("stop");
    });

    it("refuses the fourth call of a tool with a budget of 3", async () => {
        const counts = new Map<string, number>();
        const provider = scriptedProvider((i) =>
            i < 4 ? makeMessage([toolUseBlock(`tu-${i}`, "echo", { label: String(i) })], "tool_use") : makeMessage([textBlock("done")], "end_turn"),
        );

        const { messages } = await runAgent(agentDef([countingTool("echo", counts)]), GO, makeSession(), opts(provider, { toolBudget: { echo: 3 } }));

        expect(counts.get("echo")).toBe(3);
        // [user, (assistant, tool) x 4, assistant]: the fourth round's result is the refusal.
        const fourth = toolResultParts(messages[8])[0]!;
        expect(fourth.toolCallId).toBe("tu-3");
        expect(isErrorResult(fourth)).toBe(true);
        expect(String(outputValue(fourth))).toContain("limit of 3 calls");
    });

    it("counts the earlier calls of the same round against the budget", async () => {
        const counts = new Map<string, number>();
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-a", "echo", { label: "a" }), toolUseBlock("tu-b", "echo", { label: "b" })], "tool_use"),
            makeMessage([toolUseBlock("tu-c", "echo", { label: "c" }), toolUseBlock("tu-d", "echo", { label: "d" })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        const { messages } = await runAgent(agentDef([countingTool("echo", counts)]), GO, makeSession(), opts(provider, { toolBudget: { echo: 3 } }));

        expect(counts.get("echo")).toBe(3);
        const secondRound = toolResultParts(messages[4]);
        expect(secondRound.map((r) => [r.toolCallId, isErrorResult(r)])).toEqual([
            ["tu-c", false],
            ["tu-d", true],
        ]);
    });

    /**
     * A step store that replays the way DBOS does: a replayed step must land at
     * the same position with the same name, and returns the recorded value.
     */
    function stepStore(): { record: RunStep; replay: RunStep; names: () => string[] } {
        const steps: { name: string; value: unknown }[] = [];
        let position = 0;
        const record: RunStep = async (name, fn) => {
            const slot = steps.length;
            steps.push({ name, value: undefined });
            const value = await fn();
            steps[slot]!.value = value;
            return value;
        };
        const replay: RunStep = async <T>(name: string, _fn: () => Promise<T>): Promise<T> => {
            const step = steps[position++];
            if (step === undefined) throw new Error(`the replay started the step ${name}, which the recording does not hold`);
            if (step.name !== name) throw new Error(`the replay started the step ${name} where the recording holds ${step.name}`);
            return step.value as T;
        };
        return { record, replay, names: () => steps.map((step) => step.name) };
    }

    /** A provider for a replay: each model step is cached, thus a call is a failure of the test. */
    const noCallProvider = (): ScriptedProvider =>
        scriptedProvider(() => {
            throw new Error("the replay called the provider");
        });

    it("runs a refused step-mode call inside the step of its tool, and the tool does not run", async () => {
        const counts = new Map<string, number>();
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-1", "echo", { label: "x" })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);
        const rec = recordingStep();

        const { messages } = await runAgent(
            agentDef([countingTool("echo", counts)]),
            GO,
            makeSession(),
            opts(provider, { runStep: rec.runStep, toolMask: "none" }),
        );

        expect(rec.names).toEqual(["llm-0", "tool-echo-tu-1", "llm-1"]);
        expect(counts.get("echo")).toBeUndefined();
        expect(String(outputValue(toolResultParts(messages[2])[0]!))).toContain("No tool can run for this request");
    });

    it("keeps the step sequence of a round the same with and without the mask", async () => {
        const reply = () =>
            scriptedProvider([
                makeMessage([toolUseBlock("tu-a", "echo", { label: "a" }), toolUseBlock("tu-w", "writer", { label: "w" })], "tool_use"),
                makeMessage([textBlock("done")], "end_turn"),
            ]);
        const counts = new Map<string, number>();
        const tools = [countingTool("echo", counts), countingTool("writer", counts)];
        const unmasked = recordingStep();
        const masked = recordingStep();

        await runAgent(agentDef(tools), GO, makeSession(), opts(reply(), { runStep: unmasked.runStep }));
        await runAgent(agentDef(tools), GO, makeSession(), opts(reply(), { runStep: masked.runStep, toolMask: { allow: ["echo"] } }));

        expect(unmasked.names).toEqual(["llm-0", "tool-echo-tu-a", "tool-writer-tu-w", "llm-1"]);
        expect(masked.names).toEqual(unmasked.names);
        // The writer ran in the first run only.
        expect(counts.get("writer")).toBe(1);
    });

    it("runs a refused workflow-mode call with no step, the same as its dispatch", async () => {
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-wf", "workflow_echo", { label: "x" })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);
        const rec = recordingStep();
        const workflowEcho = defineTool({
            id: "workflow_echo",
            description: "A workflow-mode echo.",
            executionMode: "workflow",
            inputSchema: z.object({ label: z.string() }),
            describeCall: "none",
            execute: async ({ label }) => ok({ label }),
        });

        const { messages } = await runAgent(agentDef([workflowEcho]), GO, makeSession(), opts(provider, { runStep: rec.runStep, toolMask: "none" }));

        expect(rec.names).toEqual(["llm-0", "llm-1"]);
        expect(isErrorResult(toolResultParts(messages[2])[0]!)).toBe(true);
    });

    it("replays a refused call from its cached step", async () => {
        const store = stepStore();
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-1", "echo", { label: "x" })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);
        const first = await runAgent(agentDef([echoTool()]), GO, makeSession(), opts(provider, { runStep: store.record, toolMask: "none" }));

        const replayed = await runAgent(agentDef([echoTool()]), GO, makeSession(), opts(noCallProvider(), { runStep: store.replay, toolMask: "none" }));

        expect(store.names()).toEqual(["llm-0", "tool-echo-tu-1", "llm-1"]);
        expect(JSON.stringify(replayed.messages)).toBe(JSON.stringify(first.messages));
    });

    it("replays the step that an earlier build recorded for a call of a tool that its agent did not declare", async () => {
        // An earlier build had no `echo` tool, so it dispatched the call as
        // unknown, in a step; this build's mask must refuse it at that same step.
        const store = stepStore();
        const counts = new Map<string, number>();
        const recording = scriptedProvider([
            makeMessage([toolUseBlock("tu-1", "echo", { label: "x" })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);
        await runAgent(agentDef([]), GO, makeSession(), opts(recording, { runStep: store.record }));

        const { messages, finish } = await runAgent(
            agentDef([countingTool("echo", counts)]),
            GO,
            makeSession(),
            opts(noCallProvider(), { runStep: store.replay, toolMask: "none" }),
        );

        expect(store.names()).toEqual(["llm-0", "tool-echo-tu-1", "llm-1"]);
        expect(counts.get("echo")).toBeUndefined();
        // The cached result of the earlier build is the result of the replay.
        expect(String(outputValue(toolResultParts(messages[2])[0]!))).toContain("unknown tool: echo");
        expect(finish.reason).toBe("stop");
    });

    it("applies the mask to the earlier calls of a truncated round", async () => {
        const counts = new Map<string, number>();
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-w", "writer", { label: "w" }), toolUseBlock("tu-cut", "echo", { label: "cut" })], "max_tokens"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        const { messages } = await runAgent(
            agentDef([countingTool("echo", counts), countingTool("writer", counts)]),
            GO,
            makeSession(),
            opts(provider, { toolMask: { allow: ["echo"] } }),
        );

        expect(counts.size).toBe(0);
        const [refused, cut] = toolResultParts(messages[2]);
        expect(String(outputValue(refused!))).toContain("writer is not available for this request");
        expect(String(outputValue(cut!))).toContain("cut off");
    });

    it("dispatches each call as before with no mask and no budget", async () => {
        const counts = new Map<string, number>();
        const provider = scriptedProvider([
            makeMessage(
                [0, 1, 2, 3].map((n) => toolUseBlock(`tu-${n}`, "echo", { label: String(n) })),
                "tool_use",
            ),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        const { messages } = await runAgent(agentDef([countingTool("echo", counts)]), GO, makeSession(), opts(provider));

        expect(counts.get("echo")).toBe(4);
        expect(toolResultParts(messages[2]).every((r) => !isErrorResult(r))).toBe(true);
    });
});

// ── aborted terminal path ───────────────────────────────────────────

/**
 * An aborted reply as the streaming wrapper produces it: finish reason
 * `"aborted"` and a `string`-content assistant message holding the partial
 * (empty when the abort beat the first delta).
 */
function abortedReply(partial: string): ChatResponse {
    return { message: { role: "assistant", content: partial }, finishReason: "aborted" };
}

describe("runAgent — aborted terminal path", () => {
    it("returns the partial reply, marked interrupted, on a mid-stream abort", async () => {
        const provider = scriptedProvider([abortedReply("a partial answer the user cut off")]);

        const { messages, finish } = await runAgent(agentDef([]), GO, makeSession(), opts(provider));

        expect(finish.reason).toBe("aborted");
        // [user, assistant(partial)] — the partial joined the transcript.
        expect(messages).toHaveLength(2);
        const last = messages.at(-1)!;
        expect(last.role).toBe("assistant");
        expect(last.content).toBe("a partial answer the user cut off");
        // The partial carries the interruption marker.
        expect(isInterruptedMessage(last)).toBe(true);
    });

    it("leaves the transcript at the initial prefix on an abort before any delta", async () => {
        const provider = scriptedProvider([abortedReply("")]);

        const { messages, finish } = await runAgent(agentDef([]), GO, makeSession(), opts(provider));

        expect(finish.reason).toBe("aborted");
        // No empty assistant shell appended — the transcript is exactly the initial messages.
        expect(messages).toEqual([...GO]);
        // Nothing beyond the initial prefix, so nothing is marked.
        expect(messages.some((m) => m.role === "assistant" && isInterruptedMessage(m))).toBe(false);
    });

    it("keeps the transcript valid and leaves the tool-calling step unmarked when the abort lands during tool execution", async () => {
        // The tool honors the signal by throwing; the chat path wires no fatal
        // predicate, so the throw becomes an error tool result, the tool message
        // completes, and the FOLLOWING model call resolves aborted-empty.
        const boom = defineTool({
            id: "boom",
            description: "Honors the abort signal by throwing.",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: async () => {
                throw new Error("aborted mid-tool");
            },
        });
        const provider = scriptedProvider([makeMessage([toolUseBlock("tu-1", "boom", {})], "tool_use"), abortedReply("")]);

        const { messages, finish } = await runAgent(agentDef([boom]), GO, makeSession(), opts(provider));

        expect(finish.reason).toBe("aborted");
        // [user, assistant(tool_use), tool(error result)] — the aborted-empty reply added nothing.
        expect(messages).toHaveLength(3);

        const toolCallStep = messages[1]!;
        expect(toolCallStep.role).toBe("assistant");
        expect(isInterruptedMessage(toolCallStep)).toBe(false);

        // The tool message completes the call — no dangling tool_use.
        const results = toolResultParts(messages[2]);
        expect(results.map((r) => r.toolCallId)).toEqual(["tu-1"]);
        expect(isErrorResult(results[0]!)).toBe(true);
    });

    it("does not mark a cleanly-stopped reply", async () => {
        const provider = scriptedProvider([makeMessage([textBlock("done")], "end_turn")]);

        const { messages, finish } = await runAgent(agentDef([]), GO, makeSession(), opts(provider));

        expect(finish.reason).toBe("stop");
        expect(isInterruptedMessage(messages.at(-1)!)).toBe(false);
    });
});

describe("runAgent — aborted wrap-up path", () => {
    // A provider that never stops asking for tools in-loop — burning every iteration —
    // and, once the wrap-up request is in the transcript, resolves an abort carrying `partial`.
    function abortsAtWrapUp(partial: string): ScriptedProvider {
        return scriptedProvider((callIndex, request) =>
            isWrapUpRequest(request) ? abortedReply(partial) : makeMessage([toolUseBlock(`tu-${callIndex}`, "echo", { label: "x" })], "tool_use"),
        );
    }

    it("reports aborted with cappedOut and marks the partial when the wrap-up call aborts", async () => {
        const provider = abortsAtWrapUp("a partial the user cut off at the cap");

        const { messages, finish } = await runAgent(agentDef([echoTool()], 3), GO, makeSession(), opts(provider));

        // The abort during the wrap-up is reported as aborted; the loop still
        // genuinely exhausted its iterations, so cappedOut stays true.
        expect(finish.reason).toBe("aborted");
        expect(finish.cappedOut).toBe(true);

        // The partial joined the transcript as the tail and carries the interruption marker.
        const last = messages.at(-1)!;
        expect(last.role).toBe("assistant");
        expect(last.content).toBe("a partial the user cut off at the cap");
        expect(isInterruptedMessage(last)).toBe(true);
    });

    it("pushes nothing on an empty wrap-up abort and marks no message", async () => {
        const provider = abortsAtWrapUp("");

        const { messages, finish } = await runAgent(agentDef([echoTool()], 3), GO, makeSession(), opts(provider));

        expect(finish.reason).toBe("aborted");
        expect(finish.cappedOut).toBe(true);

        // No empty assistant shell appended — the tail is the wrap-up request.
        expect(messages.at(-1)!.role).toBe("user");
        expect(isSyntheticUserMessage(messages.at(-1)!)).toBe(true);

        expect(messages.some((m) => isInterruptedMessage(m))).toBe(false);
    });
});

// ── undispatched tool calls at a terminal finish ────────────────────

describe("runAgent — undispatched tool calls at a terminal finish", () => {
    /** A tool that records whether the loop ever executed it. */
    function probeTool(): { tool: Tool; wasExecuted: () => boolean } {
        let executed = false;
        const tool = defineTool({
            id: "probe",
            description: "Record that the loop executed this call.",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: async () => {
                executed = true;
                return ok({});
            },
        });
        return { tool, wasExecuted: () => executed };
    }

    function toolCallIdsOf(messages: readonly ModelMessage[]): string[] {
        return messages.flatMap((m) =>
            m.role === "assistant" && typeof m.content !== "string" ? m.content.filter((p) => p.type === "tool-call").map((p) => p.toolCallId) : [],
        );
    }

    it("answers the call a content-filter finish carried with the not-run result, keeps the prose, and never executes it", async () => {
        const { tool, wasExecuted } = probeTool();
        const provider = scriptedProvider([makeMessage([textBlock("I cannot continue with this."), toolUseBlock("tu-x", "probe", {})], "refusal")]);
        const logger = createCapturingLogger();

        const { messages, finish } = await runAgent(agentDef([tool]), GO, makeSession(), opts(provider, { logger }));

        expect(finish.reason).toBe("content-filter");
        expect(finish.rawFinishReason).toBe("refusal");
        expect(wasExecuted()).toBe(false);
        // [user, assistant(prose + tu-x), tool(not run)] — the reply stays whole.
        expect(messages).toHaveLength(3);
        expect(toolCallIdsOf(messages)).toEqual(["tu-x"]);
        expect(messages[1]!.content).toEqual([
            { type: "text", text: "I cannot continue with this." },
            { type: "tool-call", toolCallId: "tu-x", toolName: "probe", input: {} },
        ]);
        const [answer] = toolResultParts(messages[2]);
        expect(answer!.toolCallId).toBe("tu-x");
        expect(answer!.output).toEqual({ type: "error-text", value: NOT_RUN_TOOL_RESULT });
        const warn = logger.records.find((r) => r.level === "warn" && r.msg.includes("unanswered tool calls answered at run exit"));
        expect(warn?.fields).toMatchObject({ toolCallIds: ["tu-x"], tools: ["probe"] });
    });

    it("keeps the earlier, dispatched round intact and answers the trailing call-only reply", async () => {
        const { tool, wasExecuted } = probeTool();
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-1", "probe", {})], "tool_use"),
            makeMessage([toolUseBlock("tu-2", "probe", {})], "refusal"),
        ]);

        const { messages, finish } = await runAgent(agentDef([tool]), GO, makeSession(), opts(provider));

        expect(finish.reason).toBe("content-filter");
        expect(wasExecuted()).toBe(true);
        // [user, assistant(tu-1), tool(result tu-1), assistant(tu-2), tool(not run tu-2)]
        expect(messages).toHaveLength(5);
        expect(toolCallIdsOf(messages)).toEqual(["tu-1", "tu-2"]);
        expect(toolResultParts(messages[2]).map((r) => r.toolCallId)).toEqual(["tu-1"]);
        expect(toolResultParts(messages[4]).map((r) => [r.toolCallId, outputValue(r)])).toEqual([["tu-2", NOT_RUN_TOOL_RESULT]]);
    });

    it("dispatches a call that rides a stop finish, because a local model labels its tool replies stop", async () => {
        const { tool, wasExecuted } = probeTool();
        const provider = scriptedProvider([makeMessage([toolUseBlock("tu-x", "probe", {})], "end_turn"), makeMessage([textBlock("done")], "end_turn")]);

        const { messages, finish } = await runAgent(agentDef([tool]), GO, makeSession(), opts(provider));

        expect(finish.reason).toBe("stop");
        expect(wasExecuted()).toBe(true);
        // [user, assistant(tu-x), tool(result), assistant("done")] — the round ran and the loop continued.
        expect(messages).toHaveLength(4);
        expect(toolResultParts(messages[2]).map((r) => r.toolCallId)).toEqual(["tu-x"]);
        expect(messages.at(-1)!.content).toEqual([{ type: "text", text: "done" }]);
    });

    it("settles a call that rides an unknown finish", async () => {
        const { tool, wasExecuted } = probeTool();
        const provider = scriptedProvider([makeMessage([toolUseBlock("tu-x", "probe", {})], "unknown")]);

        const { messages, finish } = await runAgent(agentDef([tool]), GO, makeSession(), opts(provider));

        expect(finish.reason).toBe("unknown");
        expect(wasExecuted()).toBe(false);
        // [user, assistant(tu-x), tool(not run)]
        expect(messages).toHaveLength(3);
        expect(toolResultParts(messages[2]).map((r) => [r.toolCallId, outputValue(r)])).toEqual([["tu-x", NOT_RUN_TOOL_RESULT]]);
    });

    it("keeps a call-only aborted partial, marked, and answers its call", async () => {
        const { tool } = probeTool();
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-1", "probe", {})], "tool_use"),
            makeMessage([toolUseBlock("tu-2", "probe", {})], "aborted"),
        ]);

        const { messages, finish } = await runAgent(agentDef([tool]), GO, makeSession(), opts(provider));

        expect(finish.reason).toBe("aborted");
        // [user, assistant(tu-1), tool(result), assistant(tu-2), tool(not run)]
        expect(messages).toHaveLength(5);
        expect(toolCallIdsOf(messages)).toEqual(["tu-1", "tu-2"]);
        // The interruption marker rides the aborted partial, the last assistant of the run.
        expect(isInterruptedMessage(messages[3]!)).toBe(true);
        expect(isInterruptedMessage(messages[1]!)).toBe(false);
        expect(toolResultParts(messages[4]).map((r) => [r.toolCallId, outputValue(r)])).toEqual([["tu-2", NOT_RUN_TOOL_RESULT]]);
    });

    it("keeps an aborted partial with prose and a complete call, and answers the call", async () => {
        const { tool, wasExecuted } = probeTool();
        const provider = scriptedProvider([makeMessage([textBlock("Let me check"), toolUseBlock("tu-x", "probe", {})], "aborted")]);

        const { messages, finish } = await runAgent(agentDef([tool]), GO, makeSession(), opts(provider));

        expect(finish.reason).toBe("aborted");
        expect(wasExecuted()).toBe(false);
        // [user, assistant(prose + tu-x, marked), tool(not run)]
        expect(messages).toHaveLength(3);
        expect(isInterruptedMessage(messages[1]!)).toBe(true);
        expect(toolResultParts(messages[2]).map((r) => r.toolCallId)).toEqual(["tu-x"]);
    });
});

// ── finish signal on a clean stop ───────────────────────────────────

describe("runAgent — finish signal", () => {
    it("returns the real terminal stop_reason with no recoveries on a clean stop", async () => {
        const provider = scriptedProvider([makeMessage([textBlock("done")], "end_turn")]);

        const { finish } = await runAgent(agentDef([]), GO, makeSession(), opts(provider));

        expect(finish).toEqual({
            reason: "stop",
            rawFinishReason: "end_turn",
            cappedOut: false,
            truncationRecoveries: 0,
        });
    });

    it("reports cappedOut with reason max_iterations on the wrap-up path", async () => {
        const provider = scriptedProvider((callIndex, request) =>
            isWrapUpRequest(request)
                ? makeMessage([textBlock("reached")], "end_turn")
                : makeMessage([toolUseBlock(`tu-${callIndex}`, "echo", { label: "x" })], "tool_use"),
        );

        const { finish } = await runAgent(agentDef([echoTool()], 3), GO, makeSession(), opts(provider));

        expect(finish.cappedOut).toBe(true);
        expect(finish.reason).toBe("max_iterations");
    });
});

// ── Approval denial: deny-default + turn hard-stop ──────────────────

/** A tool that pauses on `ctx.ask` before its guarded action. */
function guardedTool(): Tool {
    return defineTool({
        id: "guarded",
        description: "Requests approval before acting.",
        inputSchema: z.object({}),
        describeCall: "none",
        execute: async (_input, ctx) => {
            await ctx.ask({ title: "Guarded action", command: "delete everything" });
            return ok({ ran: true });
        },
    });
}

function deniedReason(result: ToolResultPart): string {
    expect(result.output.type).toBe("execution-denied");
    return (result.output as { type: "execution-denied"; reason: string }).reason;
}

describe("runAgent — approval denial", () => {
    it("denies by default when no ask realization is wired and marks the finish denied", async () => {
        const provider = scriptedProvider([makeMessage([toolUseBlock("tu-1", "guarded", {})], "tool_use")]);

        const { messages, finish } = await runAgent(agentDef([guardedTool()]), GO, makeSession(), opts(provider));

        const result = toolResultParts(messages[2])[0]!;
        expect(result.output.type).toBe("execution-denied");
        expect(finish.reason).toBe("denied");
        // The hard-stop makes no subsequent model call.
        expect(provider.calls).toHaveLength(1);
    });

    it("hard-stops the turn on denial while a concurrent sibling's result is still appended", async () => {
        const plain = defineTool({
            id: "plain",
            description: "An ordinary tool.",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: async () => ok({ b: true }),
        });
        const provider = scriptedProvider([makeMessage([toolUseBlock("tu-A", "guarded", {}), toolUseBlock("tu-B", "plain", {})], "tool_use")]);

        const { messages, finish } = await runAgent(
            agentDef([guardedTool(), plain]),
            GO,
            makeSession(),
            opts(provider, {
                ask: async () => {
                    throw new AskRejectedError("nope");
                },
            }),
        );

        const results = toolResultParts(messages[2]);
        const denied = results.find((r) => r.toolCallId === "tu-A")!;
        const sibling = results.find((r) => r.toolCallId === "tu-B")!;

        // The sibling ran to completion and its result rides alongside the denial.
        expect(isErrorResult(sibling)).toBe(false);
        expect(outputValue(sibling)).toEqual({ b: true });
        // The denial carries the user's feedback prose.
        expect(deniedReason(denied)).toContain("nope");
        expect(finish.reason).toBe("denied");
        // No second model call — the denial is the turn's final content.
        expect(provider.calls).toHaveLength(1);
    });

    it("does not terminate the turn when the approval returns once", async () => {
        const provider = scriptedProvider([makeMessage([toolUseBlock("tu-1", "guarded", {})], "tool_use"), makeMessage([textBlock("done")], "end_turn")]);

        const { messages, finish } = await runAgent(agentDef([guardedTool()]), GO, makeSession(), opts(provider, { ask: async () => ({ kind: "once" }) }));

        const result = toolResultParts(messages[2])[0]!;
        expect(isErrorResult(result)).toBe(false);
        expect(outputValue(result)).toEqual({ ran: true });
        expect(finish.reason).toBe("stop");
        // The loop continued to a normal terminal reply — a second model call.
        expect(provider.calls).toHaveLength(2);
    });
});

// ── Event sourcing (task 2.7) ───────────────────────────────────────

describe("runAgent — event provenance", () => {
    it("stamps every event with source from the Session", async () => {
        const events: EmitEvent[] = [];
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-1", "echo", { label: "x" })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);
        const session = makeSession({
            agentId: "conversation-agent",
            callPath: ["conversation-agent"],
        });

        await runAgent(
            agentDef([echoTool()]),
            GO,
            session,
            opts(provider, {
                emit: (e) => {
                    events.push(e as EmitEvent);
                },
            }),
        );

        expect(events.length).toBeGreaterThan(0);
        for (const event of events) {
            expect(event.source.agentId).toBe("conversation-agent");
            expect(event.source.callPath).toEqual(["conversation-agent"]);
        }
        expect(events.map((e) => e.type)).toContain("tool-started");
        expect(events.map((e) => e.type)).toContain("tool-finished");
    });
});

// ── Call detail and the three-way outcome (tool-call-detail) ─────────

/** Every `tool-started` / `tool-finished` event a run emitted, in order. */
function toolEvents(events: readonly EmitEvent[]): Extract<EmitEvent, { type: "tool-started" | "tool-finished" }>[] {
    return events.filter((e): e is Extract<EmitEvent, { type: "tool-started" | "tool-finished" }> => e.type === "tool-started" || e.type === "tool-finished");
}

/** Run one scripted turn, returning the tool events it emitted. */
async function runCapturingToolEvents(
    tools: Tool[],
    provider: ScriptedProvider,
    overrides: Partial<RunAgentOptions> = {},
): Promise<Extract<EmitEvent, { type: "tool-started" | "tool-finished" }>[]> {
    const events: EmitEvent[] = [];
    await runAgent(
        agentDef(tools),
        GO,
        makeSession(),
        opts(provider, {
            ...overrides,
            emit: (e) => {
                events.push(e as EmitEvent);
            },
        }),
    );
    return toolEvents(events);
}

/** A `read` tool describing its call by path; `fail` makes `execute` throw. */
function describedRead(fail = false): Tool {
    return defineTool({
        id: "read",
        description: "Read a path.",
        inputSchema: z.object({ path: z.string() }),
        describeCall: ({ path }) => path,
        execute: async ({ path }) => {
            if (fail) throw new Error("disk on fire");
            return ok({ path });
        },
    });
}

/**
 * A `render` tool that describes its call by path and its result by the page it produced.
 * `fail` makes `execute` throw, and `breakHook` makes the result hook throw.
 */
function describedRender(options: { fail?: boolean; breakHook?: boolean } = {}): Tool<{ path: string }, { page: string }> {
    return defineTool({
        id: "render",
        description: "Render a path to a page.",
        inputSchema: z.object({ path: z.string() }),
        describeCall: ({ path }) => path,
        describeResult: (_input, { page }) => {
            if (options.breakHook === true) throw new Error("result hook is broken");
            return `page ${page}`;
        },
        execute: async ({ path }) => {
            if (options.fail === true) throw new Error("disk on fire");
            return ok({ page: `${path}.html` });
        },
    });
}

describe("runAgent — tool call detail", () => {
    it("carries the same detail on both events of a described call", async () => {
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-1", "read", { path: "output/summary.md" })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        const events = await runCapturingToolEvents([describedRead()], provider);

        expect(events).toHaveLength(2);
        expect(events[0]).toMatchObject({ type: "tool-started", name: "read", detail: "output/summary.md" });
        expect(events[1]).toMatchObject({ type: "tool-finished", name: "read", detail: "output/summary.md", outcome: "ok" });
    });

    it("omits the field entirely for a tool with no hook", async () => {
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-1", "echo", { label: "x" })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        const events = await runCapturingToolEvents([echoTool()], provider);

        expect(events).toHaveLength(2);
        for (const event of events) {
            expect("detail" in event).toBe(false);
        }
    });

    it("normalizes the detail at the emit site", async () => {
        const noisy = defineTool({
            id: "noisy",
            description: "Returns an unnormalized detail.",
            inputSchema: z.object({ text: z.string() }),
            describeCall: ({ text }) => text,
            execute: async () => ok({}),
        });
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-1", "noisy", { text: `line one\nline two ${"z".repeat(400)}` })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        const events = await runCapturingToolEvents([noisy], provider);
        const detail = (events[0] as { detail?: string }).detail!;

        expect(detail).not.toContain("\n");
        expect(detail).toHaveLength(120);
        expect(detail.endsWith("…")).toBe(true);
    });

    it("dispatches normally when the hook throws, emitting no detail", async () => {
        const broken = defineTool({
            id: "broken-hook",
            description: "Its describeCall throws.",
            inputSchema: z.object({ path: z.string() }),
            describeCall: () => {
                throw new Error("hook is broken");
            },
            execute: async ({ path }) => ok({ path }),
        });
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-1", "broken-hook", { path: "a.csv" })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        const events = await runCapturingToolEvents([broken], provider);

        expect(events[1]).toMatchObject({ type: "tool-finished", outcome: "ok" });
        expect("detail" in events[0]!).toBe(false);
        // The tool still ran and produced a real result.
        expect(provider.calls).toHaveLength(2);
    });

    it("emits no detail for an input the tool's schema rejects", async () => {
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-1", "read", { pathname: "wrong-key.md" })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        const events = await runCapturingToolEvents([describedRead()], provider);

        expect("detail" in events[0]!).toBe(false);
        expect(events[1]).toMatchObject({ type: "tool-finished", outcome: "error" });
    });
});

describe("runAgent — tool result detail", () => {
    it("names the call on the started event and the outcome on the finished one", async () => {
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-1", "render", { path: "draft" })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        const events = await runCapturingToolEvents([describedRender()], provider);

        expect(events).toHaveLength(2);
        expect(events[0]).toMatchObject({ type: "tool-started", name: "render", detail: "draft" });
        expect(events[1]).toMatchObject({ type: "tool-finished", name: "render", detail: "page draft.html", outcome: "ok" });
    });

    // The hook reads the ok value, and a failed call produced none. The started detail is the whole
    // account of what the call was, thus it stands.
    it("keeps the started detail when the call fails", async () => {
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-1", "render", { path: "draft" })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        const events = await runCapturingToolEvents([describedRender({ fail: true })], provider);

        expect(events[0]).toMatchObject({ type: "tool-started", detail: "draft" });
        expect(events[1]).toMatchObject({ type: "tool-finished", detail: "draft", outcome: "error" });
    });

    it("keeps the started detail when the result hook throws, and the call still succeeds", async () => {
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-1", "render", { path: "draft" })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        const events = await runCapturingToolEvents([describedRender({ breakHook: true })], provider);

        expect(events[1]).toMatchObject({ type: "tool-finished", detail: "draft", outcome: "ok" });
        // The tool ran and the model read its result, thus the turn continued to the reply.
        expect(provider.calls).toHaveLength(2);
    });

    it("normalizes the result detail at the emit site", async () => {
        const noisy: Tool<{ text: string }, { echoed: string }> = defineTool({
            id: "noisy_result",
            description: "Returns an unnormalized result detail.",
            inputSchema: z.object({ text: z.string() }),
            describeCall: ({ text }) => text,
            describeResult: (_input, { echoed }) => `wrote\n${echoed}`,
            execute: async ({ text }) => ok({ echoed: text }),
        });
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-1", "noisy_result", { text: `line one ${"z".repeat(400)}` })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        const events = await runCapturingToolEvents([noisy], provider);
        const detail = (events[1] as { detail?: string }).detail!;

        expect(detail.startsWith("wrote line one")).toBe(true);
        expect(detail).not.toContain("\n");
        expect(detail).toHaveLength(120);
        expect(detail.endsWith("…")).toBe(true);
    });

    // The two events of one call are positionally paired, thus a round of several calls must not let
    // one tool's result detail reach a sibling's finished event.
    it("aligns each result detail with its own call across a round", async () => {
        const provider = scriptedProvider([
            makeMessage(
                [
                    toolUseBlock("tu-1", "render", { path: "first" }),
                    toolUseBlock("tu-2", "echo", { label: "x" }),
                    toolUseBlock("tu-3", "render", { path: "last" }),
                ],
                "tool_use",
            ),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        const events = await runCapturingToolEvents([describedRender(), echoTool()], provider);
        const finished = events.filter((event) => event.type === "tool-finished");

        expect(finished).toHaveLength(3);
        expect(finished[0]).toMatchObject({ toolUseId: "tu-1", detail: "page first.html" });
        expect("detail" in finished[1]!).toBe(false);
        expect(finished[2]).toMatchObject({ toolUseId: "tu-3", detail: "page last.html" });
    });

    // A step-mode call goes through `runStep`, which hands back what a PRIOR run cached. A workflow
    // in flight when the shape of that return widened replays the bare result and never re-enters
    // the body. This step stands for such a replay: it drops the pair and gives the bare value back.
    it("reads a replayed step that cached the bare result, and keeps the started detail", async () => {
        const replayBareResult: RunStep = async (_name, fn) => {
            const settled = (await fn()) as { result?: unknown };
            // The cast restates the shape the body returns. The step store is untyped across two
            // builds of the loop, thus only the read site can state which of the two it holds.
            return (settled.result ?? settled) as never;
        };
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-1", "render", { path: "draft" })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        const events = await runCapturingToolEvents([describedRender()], provider, { runStep: replayBareResult });

        expect(events).toHaveLength(2);
        expect(events[0]).toMatchObject({ type: "tool-started", detail: "draft" });
        // A cached bare value carries no result detail, thus the call keeps the line its start showed.
        expect(events[1]).toMatchObject({ type: "tool-finished", detail: "draft", outcome: "ok" });
        // The result still reached the model, thus the turn ran to its reply.
        expect(provider.calls).toHaveLength(2);
    });
});

describe("runAgent — tool-finished outcome", () => {
    it("reports ok for a successful call", async () => {
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-1", "read", { path: "a.csv" })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        const events = await runCapturingToolEvents([describedRead()], provider);

        expect(events[1]).toMatchObject({ type: "tool-finished", outcome: "ok" });
    });

    it("reports error for a thrown tool failure", async () => {
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-1", "read", { path: "a.csv" })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        const events = await runCapturingToolEvents([describedRead(true)], provider);

        expect(events[1]).toMatchObject({ type: "tool-finished", outcome: "error" });
    });

    it("reports denied — not error — for a rejected approval", async () => {
        const provider = scriptedProvider([makeMessage([toolUseBlock("tu-1", "guarded", {})], "tool_use")]);

        const events = await runCapturingToolEvents([guardedTool()], provider, {
            ask: async () => {
                throw new AskRejectedError("nope");
            },
        });

        expect(events[1]).toMatchObject({ type: "tool-finished", outcome: "denied" });
    });

    it("reports error for input that fails validation and is never executed", async () => {
        let executed = false;
        const strict = defineTool({
            id: "strict",
            description: "Requires a numeric count.",
            inputSchema: z.object({ count: z.number() }),
            describeCall: "none",
            execute: async () => {
                executed = true;
                return ok({});
            },
        });
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-1", "strict", { count: "not a number" })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        const events = await runCapturingToolEvents([strict], provider);

        expect(events[1]).toMatchObject({ type: "tool-finished", outcome: "error" });
        expect(executed).toBe(false);
    });
});

// ── Per-call duration (see the harness-agent-loop spec) ─────────────

/** How long one call reported on its `tool-finished` event. */
function finishedDurationMs(events: readonly Extract<EmitEvent, { type: "tool-started" | "tool-finished" }>[], toolUseId: string): number {
    // The predicate narrows to the union member itself rather than to a cast
    // shape. Thus a `durationMs` dropped from `EmitEvent` fails here.
    const finished = events.find((e): e is Extract<EmitEvent, { type: "tool-finished" }> => e.type === "tool-finished" && e.toolUseId === toolUseId);
    expect(finished).toBeDefined();
    expect(typeof finished!.durationMs).toBe("number");
    return finished!.durationMs!;
}

/** The delay of the slow call in each duration case, in milliseconds. */
const SLOW_MS = 60;

/** A workflow-mode echo. The loop dispatches these one after another, not concurrently. */
function workflowEchoTool(): Tool {
    return defineTool({
        id: "workflow_echo",
        description: "Echo the label back from a workflow-backed tool.",
        executionMode: "workflow",
        inputSchema: z.object({ label: z.string(), ms: z.number().default(0) }),
        describeCall: "none",
        execute: async ({ label, ms }) => {
            if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
            return ok({ label });
        },
    });
}

describe("runAgent — per-call duration", () => {
    it("reports the own duration of each concurrent step-mode call", async () => {
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-slow", "echo", { label: "slow", ms: SLOW_MS }), toolUseBlock("tu-fast", "echo", { label: "fast" })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        const events = await runCapturingToolEvents([echoTool()], provider);

        // The round takes as long as the slow call. Thus one shared round figure
        // would charge the fast call for the slow one.
        expect(finishedDurationMs(events, "tu-slow")).toBeGreaterThanOrEqual(SLOW_MS - 10);
        expect(finishedDurationMs(events, "tu-fast")).toBeLessThan(SLOW_MS - 20);
    });

    it("does not charge a sequential workflow-mode call for its predecessor", async () => {
        const provider = scriptedProvider([
            makeMessage(
                [toolUseBlock("tu-first", "workflow_echo", { label: "first", ms: SLOW_MS }), toolUseBlock("tu-second", "workflow_echo", { label: "second" })],
                "tool_use",
            ),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        const events = await runCapturingToolEvents([workflowEchoTool()], provider);

        // The second call dispatches only after the first call completes. A figure
        // that started at the start of the round would include the first delay.
        expect(finishedDurationMs(events, "tu-first")).toBeGreaterThanOrEqual(SLOW_MS - 10);
        expect(finishedDurationMs(events, "tu-second")).toBeLessThan(SLOW_MS - 20);
    });

    it("reports a duration for a call that errors", async () => {
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-1", "read", { path: "a.csv" })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        const events = await runCapturingToolEvents([describedRead(true)], provider);

        expect(events[1]).toMatchObject({ type: "tool-finished", outcome: "error" });
        expect(finishedDurationMs(events, "tu-1")).toBeGreaterThanOrEqual(0);
    });

    it("reports a duration on the truncated-round path too", async () => {
        // The truncated round is the second dispatch path. It must report timing
        // through the same call as the normal one, or the two disagree.
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-A", "echo", { label: "A", ms: SLOW_MS }), toolUseBlock("tu-cut", "echo", { label: "cut" })], "max_tokens"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        const events = await runCapturingToolEvents([echoTool()], provider);

        expect(finishedDurationMs(events, "tu-A")).toBeGreaterThanOrEqual(SLOW_MS - 10);
        // The trailing call is refused rather than dispatched, thus it settles
        // outside the round and reports no finished event of its own.
        expect(events.some((e) => e.type === "tool-finished" && e.toolUseId === "tu-cut")).toBe(false);
    });
});

// ── round sink (see the harness-agent-loop spec) ─────────────────────

/** A round sink that keeps a copy of each round that it gets. */
function recordingSink(): { onRound: (round: AgentRound) => Promise<void>; rounds: LoopMessage[][] } {
    const rounds: LoopMessage[][] = [];
    return {
        rounds,
        onRound: async (round) => {
            rounds.push([...round.messages]);
        },
    };
}

describe("runAgent — round sink", () => {
    const echoCall = (id: string): ChatResponse => makeMessage([toolUseBlock(id, "echo", { label: id })], "tool_use");
    const threeRequests = (): ChatResponse[] => [echoCall("tu-1"), echoCall("tu-2"), makeMessage([textBlock("done")], "end_turn")];

    it("gives rounds that follow the initial messages and equal the messages of the result", async () => {
        const provider = scriptedProvider(threeRequests());
        const sink = recordingSink();

        const { messages } = await runAgent(agentDef([echoTool()]), GO, makeSession(), opts(provider, { onRound: sink.onRound }));

        expect([...GO, ...sink.rounds.flat()]).toEqual(messages);
    });

    it("holds each earlier reply and tool message when the provider gets the next request", async () => {
        const sink = recordingSink();
        const replies = threeRequests();
        const held: boolean[] = [];
        const provider = scriptedProvider((callIndex, request) => {
            held.push(JSON.stringify(request.messages) === JSON.stringify([...GO, ...sink.rounds.flat()]));
            return replies[callIndex]!;
        });

        await runAgent(agentDef([echoTool()]), GO, makeSession(), opts(provider, { onRound: sink.onRound, promptCache: "off" }));

        expect(held).toEqual([true, true, true]);
    });

    it("gives no empty round", async () => {
        const provider = scriptedProvider(threeRequests());
        const sink = recordingSink();

        await runAgent(agentDef([echoTool()]), GO, makeSession(), opts(provider, { onRound: sink.onRound }));

        expect(sink.rounds).toHaveLength(3);
        expect(sink.rounds.every((round) => round.length > 0)).toBe(true);
    });

    it("gives a truncated prose reply and its steer in one round", async () => {
        const provider = scriptedProvider([makeMessage([textBlock("a long answer that")], "max_tokens"), makeMessage([textBlock("ends here")], "end_turn")]);
        const sink = recordingSink();

        await runAgent(agentDef([]), GO, makeSession(), opts(provider, { onRound: sink.onRound }));

        const first = sink.rounds[0]!;
        expect(first.map((m) => m.role)).toEqual(["assistant", "user"]);
        expect(isSyntheticUserMessage(first[1]!)).toBe(true);
    });

    it("holds the wrap-up request when the loop sends the first wrap-up request", async () => {
        const sink = recordingSink();
        let heldAtWrapUp: boolean | undefined;
        const provider = scriptedProvider((callIndex, request) => {
            if (!isWrapUpRequest(request)) return echoCall(`tu-${callIndex}`);
            heldAtWrapUp ??= sink.rounds.at(-1)!.some((m) => m.role === "user" && m.content === WRAP_UP_REQUEST);
            return makeMessage([textBlock("here is where I reached")], "end_turn");
        });

        await runAgent(agentDef([echoTool()], 1), GO, makeSession(), opts(provider, { onRound: sink.onRound }));

        expect(heldAtWrapUp).toBe(true);
    });

    it("gives the assistant message and a not-run result before a fatal tool throw", async () => {
        const fatal = new Error("workflow cancelled");
        const workflow = defineTool({
            id: "workflow_fatal",
            description: "Throws a fatal workflow error.",
            executionMode: "workflow",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: async () => {
                throw fatal;
            },
        });
        const provider = scriptedProvider([makeMessage([toolUseBlock("tu-1", "workflow_fatal", {})], "tool_use")]);
        const sink = recordingSink();

        await expect(
            runAgent(agentDef([workflow]), GO, makeSession(), opts(provider, { onRound: sink.onRound, isFatalLoopError: (e) => e === fatal })),
        ).rejects.toBe(fatal);

        const last = sink.rounds.at(-1)!;
        expect(last.map((m) => m.role)).toEqual(["assistant", "tool"]);
        expect(toolResultParts(last[1]).map((r) => [r.toolCallId, outputValue(r)])).toEqual([["tu-1", NOT_RUN_TOOL_RESULT]]);
    });

    it("gives no round when the first request fails", async () => {
        const failing: AgentChat = {
            capabilities: { toolCalling: true },
            chat: () => errAsync({ type: "provider", retryable: false, message: "the endpoint failed" }),
        };
        const sink = recordingSink();

        await expect(runAgent(agentDef([]), GO, makeSession(), { ...opts(scriptedProvider([])), provider: failing, onRound: sink.onRound })).rejects.toThrow(
            "the endpoint failed",
        );

        expect(sink.rounds).toEqual([]);
    });

    it("does not call a sink again after it rejects, and throws its rejection", async () => {
        const rejection = new Error("the store is gone");
        let calls = 0;
        const provider = scriptedProvider(threeRequests());

        await expect(
            runAgent(
                agentDef([echoTool()]),
                GO,
                makeSession(),
                opts(provider, {
                    onRound: async () => {
                        calls++;
                        throw rejection;
                    },
                }),
            ),
        ).rejects.toBe(rejection);

        expect(calls).toBe(1);
    });

    it("gives the same messages and the same finish with and without a sink", async () => {
        const sink = recordingSink();

        const withSink = await runAgent(agentDef([echoTool()]), GO, makeSession(), opts(scriptedProvider(threeRequests()), { onRound: sink.onRound }));
        const withoutSink = await runAgent(agentDef([echoTool()]), GO, makeSession(), opts(scriptedProvider(threeRequests())));

        expect(withSink.messages).toEqual(withoutSink.messages);
        expect(withSink.finish).toEqual(withoutSink.finish);
    });
});

// ── continueAgent (see the harness-agent-loop spec) ──────────────────

describe("continueAgent", () => {
    /** A finished conversation of one tool round and a closing text reply, and the provider that ran it. */
    async function conversation(): Promise<{ messages: ModelMessage[]; provider: ScriptedProvider; agent: AgentDefinition }> {
        const agent = agentDef([echoTool()]);
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-1", "echo", { label: "x" })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);
        const { messages } = await runAgent(agent, GO, makeSession(), opts(provider, { promptCache: "off" }));
        return { messages, provider, agent };
    }

    it("sends the system prompt, the tools, and each message of the conversation unchanged", async () => {
        const { messages, provider: first, agent } = await conversation();
        const provider = scriptedProvider([makeMessage([textBlock("summary")], "end_turn")]);

        await continueAgent(
            agent,
            messages,
            { text: "Summarize the work.", mask: "none", maxRequests: 2, stepNamespace: "step-summary" },
            makeSession(),
            opts(provider, { promptCache: "off" }),
        );

        const request = provider.calls[0]!;
        const lastOfConversation = first.calls.at(-1)!;
        expect(request.system).toEqual(lastOfConversation.system);
        expect(Object.keys(request.tools)).toEqual(Object.keys(lastOfConversation.tools));
        expect(request.toolChoice).toBeUndefined();
        expect(JSON.stringify(request.messages.slice(0, messages.length))).toBe(JSON.stringify(messages));
    });

    it("returns only the synthetic request and the new messages, and changes no message of the conversation", async () => {
        const { messages, agent } = await conversation();
        const before = JSON.stringify(messages);
        const provider = scriptedProvider([makeMessage([textBlock("summary")], "end_turn")]);

        const result = await continueAgent(
            agent,
            messages,
            { text: "Summarize the work.", mask: "none", maxRequests: 2, stepNamespace: "step-summary" },
            makeSession(),
            opts(provider),
        );

        expect(result.messages).toHaveLength(2);
        expect(isSyntheticUserMessage(result.messages[0]!)).toBe(true);
        expect(result.messages[0]!.content).toBe("Summarize the work.");
        expect(result.messages[1]!.content).toEqual([{ type: "text", text: "summary" }]);
        expect(result.finish).toMatchObject({ reason: "stop", cappedOut: false });
        expect(JSON.stringify(messages)).toBe(before);
    });

    it("ends at its cap with no wrap-up request", async () => {
        const { messages, agent } = await conversation();
        const provider = scriptedProvider((i) => makeMessage([toolUseBlock(`tu-c${i}`, "echo", { label: "again" })], "tool_use"));

        const result = await continueAgent(
            agent,
            messages,
            { text: "Answer in text.", mask: "none", maxRequests: 2, stepNamespace: "wrap" },
            makeSession(),
            opts(provider),
        );

        expect(provider.calls).toHaveLength(2);
        expect(provider.calls.every((call) => call.toolChoice === undefined)).toBe(true);
        expect(result.finish).toMatchObject({ reason: "max_iterations", cappedOut: true });
        // [request, assistant, tool(refused), assistant, tool(refused)]
        expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "tool"]);
    });

    it("records each call under the accounting agent id and the step of the session", async () => {
        const { messages, agent } = await conversation();
        const records: LlmUsageRecord[] = [];
        const provider = scriptedProvider([makeMessage([textBlock("summary")], "end_turn", { inputTokens: 10, outputTokens: 2 })]);
        const session: AgentSession = { ...makeSession(), runFrame: { runId: "run-1", stepId: "T1S1" } };

        await continueAgent(
            agent,
            messages,
            { text: "Summarize.", mask: "none", maxRequests: 2, stepNamespace: "step-summary", accountingAgentId: "step-summary-writer" },
            session,
            opts(provider, {
                usageRecorder: {
                    record: (record) => {
                        records.push(record);
                        return okAsync(undefined);
                    },
                },
            }),
        );

        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ agentId: "step-summary-writer", runId: "run-1", stepId: "T1S1" });
        expect(records[0]!.callPath).toEqual(["conversation-agent", "step-summary-writer"]);
        expect(records[0]!.recordKey.endsWith(":step-summary:llm-0")).toBe(true);
    });

    it("names each step under the namespace", async () => {
        const { messages, agent } = await conversation();
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-m", "echo", { label: "m" })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);
        const rec = recordingStep();

        await continueAgent(
            agent,
            messages,
            { text: "Describe the files.", mask: { allow: ["echo"] }, maxRequests: 8, stepNamespace: "file-metadata" },
            makeSession(),
            opts(provider, { runStep: rec.runStep }),
        );

        expect(rec.names).toEqual(["file-metadata:llm-0", "file-metadata:tool-echo-tu-m", "file-metadata:llm-1"]);
    });

    it("gives the request text in the first round and the reply in the next round", async () => {
        const { messages, agent } = await conversation();
        const provider = scriptedProvider([makeMessage([textBlock("summary")], "end_turn")]);
        const sink = recordingSink();

        await continueAgent(
            agent,
            messages,
            { text: "Summarize the work.", mask: "none", maxRequests: 2, stepNamespace: "step-summary" },
            makeSession(),
            opts(provider, { onRound: sink.onRound }),
        );

        expect(sink.rounds).toHaveLength(2);
        expect(sink.rounds[0]!.map((m) => m.content)).toEqual(["Summarize the work."]);
        expect(sink.rounds[1]!.map((m) => m.content)).toEqual([[{ type: "text", text: "summary" }]]);
    });
});

// ── compaction (see the harness-agent-loop spec) ─────────────────────

describe("runAgent — compaction", () => {
    const COMPACT = "Summarize the conversation above.";
    const RECORD = contextRecordMessage("run-activity", "[Run Activity]\nNo runs are currently running or suspended.");
    const SUMMARY = "The user compares two groups of samples.";

    /** Text of about `n` tokens. */
    const big = (n: number): string => Array.from({ length: n }, () => "word").join(" ");

    const bigCall = (id: string, reasoning?: string): ChatResponse =>
        makeMessage([...(reasoning === undefined ? [] : [thinkingBlock(reasoning, `SIG-${id}`)]), toolUseBlock(id, "echo", { label: big(1_500) })], "tool_use");
    const smallCall = (id: string): ChatResponse => makeMessage([toolUseBlock(id, "echo", { label: id })], "tool_use");
    const text = (reply: string, usage?: ChatUsage): ChatResponse => makeMessage([textBlock(reply)], "end_turn", usage);

    function isExchangeRequest(request: ChatRequest): boolean {
        return request.messages.some((message) => message.role === "user" && message.content === COMPACT);
    }

    interface SentRequest {
        readonly exchange: boolean;
        readonly messages: ModelMessage[];
        readonly toolNames: string[];
        readonly system: unknown;
    }

    /** A provider that answers the task requests from `task` and the requests of an exchange from `exchange`, and copies each request. */
    function compactingProvider(task: readonly ChatResponse[], exchange: readonly ChatResponse[]): { provider: ScriptedProvider; sent: SentRequest[] } {
        const sent: SentRequest[] = [];
        let taskCalls = 0;
        let exchangeCalls = 0;
        const provider = scriptedProvider((_callIndex, request) => {
            const isExchange = isExchangeRequest(request);
            sent.push({
                exchange: isExchange,
                messages: JSON.parse(JSON.stringify(request.messages)) as ModelMessage[],
                toolNames: Object.keys(request.tools),
                system: request.system,
            });
            const reply = isExchange ? exchange[exchangeCalls++] : task[taskCalls++];
            if (reply === undefined) throw new Error(`no scripted ${isExchange ? "exchange" : "task"} reply`);
            return reply;
        });
        return { provider, sent };
    }

    function policyOf(provider: AgentChat, overrides: Partial<CompactionPolicy> = {}): CompactionPolicy {
        return { budget: 1_000, provider, request: COMPACT, mask: { allow: ["echo"] }, keepFirstTurn: false, recordsAfter: async () => [RECORD], ...overrides };
    }

    function failingChat(error: ProviderError): AgentChat {
        return { capabilities: { toolCalling: true }, chat: () => errAsync(error) };
    }

    const refusal400: ProviderError = {
        type: "provider",
        retryable: false,
        message: "Provider call failed for analysis:analysis-001 (HTTP 400): prompt is too long",
        cause: { status: 400 },
    };

    function compactionParts(events: readonly Parameters<EmitFn>[0][]): { id: string; status: string; tokensAfter?: number; durationMs?: number }[] {
        return events.filter((event) => event.type === "data-compaction").map((event) => (event as { data: { id: string; status: string } }).data);
    }

    function markersOf(messages: readonly ModelMessage[]): string[] {
        return messages.flatMap((message) => {
            const marker = compactionMarkerOf(message);
            return marker === undefined ? [] : [marker.kind];
        });
    }

    it("sends the transcript and runs no exchange for a run with no policy", async () => {
        const initial: ModelMessage[] = [{ role: "user", content: big(3_000) }];
        const { provider, sent } = compactingProvider([smallCall("tu-1"), text("done")], []);

        const { messages } = await runAgent(agentDef([echoTool()]), initial, makeSession(), opts(provider, { promptCache: "off" }));

        expect(sent.map((request) => request.exchange)).toEqual([false, false]);
        expect(sent[1]!.messages).toEqual(messages.slice(0, 3));
        expect(markersOf(messages)).toEqual([]);
    });

    it("runs no exchange for a view within the budget", async () => {
        const { provider, sent } = compactingProvider([bigCall("tu-1"), text("done")], []);

        const { messages } = await runAgent(
            agentDef([echoTool()]),
            GO,
            makeSession(),
            opts(provider, { compaction: policyOf(provider, { budget: 1_000_000 }) }),
        );

        expect(sent.map((request) => request.exchange)).toEqual([false, false]);
        expect(markersOf(messages)).toEqual([]);
    });

    it("runs the exchange after the round that passes the budget, before the next request", async () => {
        const { provider, sent } = compactingProvider([bigCall("tu-1"), text("done")], [text(SUMMARY)]);

        const { messages, finish } = await runAgent(agentDef([echoTool()]), GO, makeSession(), opts(provider, { compaction: policyOf(provider) }));

        expect(sent.map((request) => request.exchange)).toEqual([false, true, false]);
        expect(finish.reason).toBe("stop");
        // [user, assistant(call), tool, request, summary reply, marker, record, assistant(done)]
        expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "user", "assistant", "user", "user", "assistant"]);
        expect(messages.slice(3, 5).map((message) => compactionExchangeOf(message))).toEqual([expect.any(String), expect.any(String)]);
        expect(compactionMarkerOf(messages[5]!)).toMatchObject({ kind: "summary", id: compactionExchangeOf(messages[3]!) });
        expect(messages[5]!.content).toBe(`[Conversation Summary]\n${SUMMARY}`);
        expect(messages[6]).toEqual(RECORD);
    });

    it("sends the tools of the run in the exchange, and starts its messages with the view, byte-identical", async () => {
        const { provider, sent } = compactingProvider([bigCall("tu-1"), text("done")], [text(SUMMARY)]);

        const { messages } = await runAgent(agentDef([echoTool()]), GO, makeSession(), opts(provider, { compaction: policyOf(provider), promptCache: "off" }));

        const [task, exchange] = sent;
        expect(exchange!.toolNames).toEqual(task!.toolNames);
        expect(exchange!.system).toEqual(task!.system);
        expect(JSON.stringify(exchange!.messages.slice(0, 3))).toBe(JSON.stringify(messages.slice(0, 3)));
        expect(exchange!.messages.slice(3)).toEqual([expect.objectContaining({ role: "user", content: COMPACT })]);
    });

    it("sends the marker and the records after a summary, and no message of the exchange", async () => {
        const { provider, sent } = compactingProvider([bigCall("tu-1"), text("done")], [smallCall("tu-m"), text(SUMMARY)]);

        await runAgent(agentDef([echoTool()]), GO, makeSession(), opts(provider, { compaction: policyOf(provider) }));

        const after = sent.at(-1)!;
        expect(after.exchange).toBe(false);
        expect(after.messages.map((message) => message.content)).toEqual([`[Conversation Summary]\n${SUMMARY}`, RECORD.content]);
        expect(after.messages.some((message) => compactionExchangeOf(message) !== undefined)).toBe(false);
    });

    it("marks each message of the exchange with the id of the compaction", async () => {
        const { provider } = compactingProvider([bigCall("tu-1"), text("done")], [smallCall("tu-m"), text(SUMMARY)]);

        const { messages } = await runAgent(agentDef([echoTool()]), GO, makeSession(), opts(provider, { compaction: policyOf(provider) }));

        const exchange = messages.slice(3, 7);
        expect(exchange.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
        const ids = new Set(exchange.map((message) => compactionExchangeOf(message)));
        expect(ids.size).toBe(1);
        expect(compactionMarkerOf(messages[7]!)?.id).toBe([...ids][0]!);
    });

    it("compacts before the first request when the initial messages pass the budget", async () => {
        const initial: ModelMessage[] = [{ role: "user", content: big(3_000) }];
        const { provider, sent } = compactingProvider([text("done")], [text(SUMMARY)]);

        await runAgent(agentDef([echoTool()]), initial, makeSession(), opts(provider, { compaction: policyOf(provider) }));

        expect(sent.map((request) => request.exchange)).toEqual([true, false]);
        expect(sent[1]!.messages.map((message) => message.content)).toEqual([`[Conversation Summary]\n${SUMMARY}`, RECORD.content]);
    });

    it("starts a second compaction from the first summary marker", async () => {
        const { provider, sent } = compactingProvider([bigCall("tu-1"), bigCall("tu-2"), text("done")], [text("first summary"), text("second summary")]);

        const { messages } = await runAgent(agentDef([echoTool()]), GO, makeSession(), opts(provider, { compaction: policyOf(provider) }));

        const exchanges = sent.filter((request) => request.exchange);
        expect(exchanges).toHaveLength(2);
        expect(exchanges[1]!.messages[0]!.content).toBe("[Conversation Summary]\nfirst summary");
        expect(exchanges[1]!.messages.filter((message) => message.content === COMPACT)).toHaveLength(1);
        expect(markersOf(messages)).toEqual(["summary", "summary"]);
        expect(sent.at(-1)!.messages[0]!.content).toBe("[Conversation Summary]\nsecond summary");
    });

    it("keeps the first turn in front of the marker", async () => {
        const seed = syntheticRecordMessage("[Report Brief]\nDraft the methods section.");
        const { provider, sent } = compactingProvider([bigCall("tu-1"), text("done")], [text(SUMMARY)]);

        await runAgent(agentDef([echoTool()]), [seed, ...GO], makeSession(), opts(provider, { compaction: policyOf(provider, { keepFirstTurn: true }) }));

        expect(sent.at(-1)!.messages.map((message) => message.content)).toEqual([seed.content, `[Conversation Summary]\n${SUMMARY}`, RECORD.content]);
    });

    it("refuses a tool outside the mask during the exchange", async () => {
        let writes = 0;
        const writer = defineTool({
            id: "writer",
            description: "Counts each write.",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: async () => {
                writes++;
                return ok({ written: true });
            },
        });
        const { provider } = compactingProvider(
            [bigCall("tu-1"), text("done")],
            [makeMessage([toolUseBlock("tu-w", "writer", {})], "tool_use"), text(SUMMARY)],
        );

        const { messages } = await runAgent(agentDef([echoTool(), writer]), GO, makeSession(), opts(provider, { compaction: policyOf(provider) }));

        expect(writes).toBe(0);
        const [refused] = toolResultParts(messages[5]);
        expect(isErrorResult(refused!)).toBe(true);
        expect(String(outputValue(refused!))).toContain("writer is not available for this request");
    });

    it("appends a drop marker when the exchange calls a tool in each of its requests", async () => {
        const replies = Array.from({ length: COMPACTION_MAX_REQUESTS }, (_, i) => smallCall(`tu-m${i}`));
        const { provider, sent } = compactingProvider([bigCall("tu-1"), text("done")], replies);

        const { messages, finish } = await runAgent(agentDef([echoTool()]), GO, makeSession(), opts(provider, { compaction: policyOf(provider) }));

        expect(sent.filter((request) => request.exchange)).toHaveLength(COMPACTION_MAX_REQUESTS);
        expect(markersOf(messages)).toEqual(["drop"]);
        expect(finish.reason).toBe("stop");
    });

    it("drops on a 400 refusal of the exchange, warns with the status and the error text, and does not throw", async () => {
        const logger = createCapturingLogger();
        const events: Parameters<EmitFn>[0][] = [];
        const task = scriptedProvider([bigCall("tu-1"), text("done")]);

        const { messages, finish } = await runAgent(
            agentDef([echoTool()]),
            GO,
            makeSession(),
            opts(task, {
                compaction: policyOf(failingChat(refusal400)),
                logger,
                emit: (event) => {
                    events.push(event);
                },
            }),
        );

        expect(finish.reason).toBe("stop");
        expect(markersOf(messages)).toEqual(["drop"]);
        const warn = logger.records.find((record) => record.level === "warn" && record.msg.includes("compaction gave no summary"));
        expect(warn?.fields).toMatchObject({ status: 400, providerError: refusal400.message, keptTurns: 1 });
        expect(compactionParts(events).map((part) => part.status)).toEqual(["running", "failed"]);
        expect(compactionParts(events)[1]).toMatchObject({ tokensAfter: expect.any(Number), durationMs: expect.any(Number) });
    });

    it.each<[string, ProviderError]>([
        ["an auth error", { type: "auth", retryable: false, message: "401 Unauthorized" }],
        ["a suspend error", { type: "suspend", retryable: false, reason: "payment_required", status: 402, message: "Payment Required" }],
        ["a transient error", { type: "provider", retryable: true, message: "overloaded", cause: { status: 529 } }],
    ])("throws %s of the exchange, with no marker and the part failed", async (_label, error) => {
        const events: Parameters<EmitFn>[0][] = [];
        const sink = recordingSink();
        const task = scriptedProvider([bigCall("tu-1"), text("done")]);

        await expect(
            runAgent(
                agentDef([echoTool()]),
                GO,
                makeSession(),
                opts(task, {
                    compaction: policyOf(failingChat(error)),
                    onRound: sink.onRound,
                    emit: (event) => {
                        events.push(event);
                    },
                }),
            ),
        ).rejects.toThrow(error.message);

        expect(markersOf(sink.rounds.flat())).toEqual([]);
        expect(sink.rounds.flat().some((message) => compactionExchangeOf(message) !== undefined)).toBe(false);
        expect(compactionParts(events).map((part) => part.status)).toEqual(["running", "failed"]);
    });

    it("keeps the previous summary in front of a drop, and sends no kept reasoning", async () => {
        let exchanges = 0;
        const summaryThenRefusal: AgentChat = {
            capabilities: { toolCalling: true },
            chat: () => (exchanges++ === 0 ? okAsync(text("first summary")) : errAsync(refusal400)),
        };
        const { provider, sent } = compactingProvider([bigCall("tu-1"), bigCall("tu-2", "weighing the second call"), text("done")], []);

        const { messages } = await runAgent(agentDef([echoTool()]), GO, makeSession(), opts(provider, { compaction: policyOf(summaryThenRefusal) }));

        expect(markersOf(messages)).toEqual(["summary", "drop"]);
        const afterDrop = sent.at(-1)!;
        expect(afterDrop.messages[0]!.content).toBe("[Conversation Summary]\nfirst summary");
        const parts = afterDrop.messages.flatMap((message) => (typeof message.content === "string" ? [] : message.content));
        expect(parts.some((part) => part.type === "reasoning")).toBe(false);
        expect(parts.some((part) => part.type === "tool-call" && part.toolCallId === "tu-2")).toBe(true);
    });

    it("runs no second compaction after a drop", async () => {
        const { provider, sent } = compactingProvider([bigCall("tu-1"), bigCall("tu-2"), bigCall("tu-3"), text("done")], []);

        const { messages } = await runAgent(agentDef([echoTool()]), GO, makeSession(), opts(provider, { compaction: policyOf(failingChat(refusal400)) }));

        expect(markersOf(messages)).toEqual(["drop"]);
        expect(sent).toHaveLength(4);
    });

    it("ends the run aborted with the exchange and no marker when an abort ends the exchange", async () => {
        const events: Parameters<EmitFn>[0][] = [];
        const aborting: AgentChat = { capabilities: { toolCalling: true }, chat: () => okAsync(abortedReply("a partial summ")) };
        const task = scriptedProvider([bigCall("tu-1")]);

        const { messages, finish } = await runAgent(
            agentDef([echoTool()]),
            GO,
            makeSession(),
            opts(task, {
                compaction: policyOf(aborting),
                emit: (event) => {
                    events.push(event);
                },
            }),
        );

        expect(finish.reason).toBe("aborted");
        expect(markersOf(messages)).toEqual([]);
        expect(messages.slice(3).every((message) => compactionExchangeOf(message) !== undefined)).toBe(true);
        expect(messages.at(-1)).toMatchObject({ role: "assistant", content: "a partial summ" });
        expect(compactionParts(events).map((part) => part.status)).toEqual(["running", "failed"]);
    });

    it("gives the sink the exchange as one round and then the marker with its records, and the rounds equal the result", async () => {
        const sink = recordingSink();
        const { provider } = compactingProvider([bigCall("tu-1"), text("done")], [smallCall("tu-m"), text(SUMMARY)]);

        const { messages } = await runAgent(
            agentDef([echoTool()]),
            GO,
            makeSession(),
            opts(provider, { compaction: policyOf(provider), onRound: sink.onRound }),
        );

        expect([...GO, ...sink.rounds.flat()]).toEqual(messages);
        expect(sink.rounds.map((round) => round.length)).toEqual([2, 4, 2, 1]);
        expect(sink.rounds[1]!.every((message) => compactionExchangeOf(message) !== undefined)).toBe(true);
        expect(markersOf(sink.rounds[2]!)).toEqual(["summary"]);
        expect(sink.rounds[2]![1]).toEqual(RECORD);
    });

    it("emits running and then done under one id, with the source of the run", async () => {
        const events: Parameters<EmitFn>[0][] = [];
        const { provider } = compactingProvider([bigCall("tu-1"), text("done")], [smallCall("tu-m"), text(SUMMARY)]);
        const session = makeSession({ agentId: "conversation-agent", callPath: ["tui-chat"] });

        const { messages } = await runAgent(
            agentDef([echoTool()]),
            GO,
            session,
            opts(provider, {
                compaction: policyOf(provider),
                emit: (event) => {
                    events.push(event);
                },
            }),
        );

        const parts = events.filter((event) => event.type === "data-compaction");
        expect(parts.map((event) => ("source" in event ? event.source?.callPath : undefined))).toEqual([["tui-chat"], ["tui-chat"]]);
        const [running, done] = compactionParts(events);
        expect(running).toMatchObject({ status: "running", tokensBefore: expect.any(Number) });
        expect(done).toMatchObject({ id: running!.id, status: "done", tokensAfter: expect.any(Number), durationMs: expect.any(Number) });
        expect(compactionMarkerOf(messages.find((message) => compactionMarkerOf(message) !== undefined)!)).toMatchObject({
            id: running!.id,
            tokensAfter: done!.tokensAfter,
            durationMs: done!.durationMs,
        });
        const exchangeEvents = events.filter((event) => event.type === "tool-started" && event.toolUseId === "tu-m");
        expect(exchangeEvents.map((event) => ("source" in event ? event.source?.callPath : undefined))).toEqual([["tui-chat", "test-agent-compaction"]]);
    });

    it("records the calls of the exchange under the compaction id, and the turn total holds them", async () => {
        const records: LlmUsageRecord[] = [];
        const { provider } = compactingProvider(
            [
                makeMessage([toolUseBlock("tu-1", "echo", { label: big(1_500) })], "tool_use", { inputTokens: 100, outputTokens: 10 }),
                text("done", { inputTokens: 20, outputTokens: 2 }),
            ],
            [text(SUMMARY, { inputTokens: 1_000, outputTokens: 50 })],
        );

        const { finish } = await runAgent(
            agentDef([echoTool()]),
            GO,
            makeSession(),
            opts(provider, {
                compaction: policyOf(provider),
                usageRecorder: {
                    record: (record) => {
                        records.push(record);
                        return okAsync(undefined);
                    },
                },
            }),
        );

        expect(records.map((record) => record.agentId)).toEqual(["conversation-agent", "test-agent-compaction", "conversation-agent"]);
        expect(finish.usage).toMatchObject({ inputTokens: 120, outputTokens: 12 });
        expect(finish.turnUsage).toMatchObject({ inputTokens: 1_120, outputTokens: 62 });
    });

    it("runs no exchange before a wrap-up request", async () => {
        const provider = scriptedProvider((_i, request) => (isWrapUpRequest(request) ? text("where I reached") : bigCall("tu-1")));

        const { finish } = await runAgent(agentDef([echoTool()], 1), GO, makeSession(), opts(provider, { compaction: policyOf(provider) }));

        expect(finish.reason).toBe("max_iterations");
        expect(provider.calls.some(isExchangeRequest)).toBe(false);
    });

    it("runs no exchange before the request that continues a truncated reply", async () => {
        const provider = scriptedProvider([makeMessage([textBlock(big(3_000))], "max_tokens"), text("the end")]);

        const { finish } = await runAgent(agentDef([echoTool()]), GO, makeSession(), opts(provider, { compaction: policyOf(provider) }));

        expect(finish.reason).toBe("stop");
        expect(provider.calls).toHaveLength(2);
        expect(provider.calls.some(isExchangeRequest)).toBe(false);
    });
});
