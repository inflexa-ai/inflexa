import { describe, expect, it } from "bun:test";
import type { ModelMessage, ToolResultPart } from "ai";
import { err, ok } from "neverthrow";
import { z } from "zod";

import { createCapturingLogger } from "../__tests__/setup/logger.js";
import { isInterruptedMessage, isSyntheticUserMessage } from "../memory/ai-sdk-message-storage.js";
import { makeSession } from "../providers/__fixtures__/session.js";
import type { ChatResponse } from "../providers/types.js";
import { AskRejectedError } from "../tools/approval/contract.js";
import { defineTool, withToolResultImage, type Tool } from "../tools/define-tool.js";
import { makeMessage, scriptedProvider, type ScriptedProvider, textBlock, thinkingBlock, toolUseBlock } from "./__fixtures__/scripted-provider.js";
import { runAgent, type RunAgentOptions } from "./run-agent.js";
import { passthroughStep } from "./run-step.js";
import type { AgentDefinition, EmitEvent, RunStep } from "./types.js";

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
    it("forces one tool-less call at the cap and returns without throwing", async () => {
        // The provider never stops asking for tools — except when handed an
        // empty tool list, which forces the wrap-up text reply.
        const provider = scriptedProvider((callIndex, request) =>
            request.tools !== undefined && Object.keys(request.tools).length === 0
                ? makeMessage([textBlock("here is where I reached")], "end_turn")
                : makeMessage([toolUseBlock(`tu-${callIndex}`, "echo", { label: "x" })], "tool_use"),
        );

        const { messages } = await runAgent(agentDef([echoTool()], 3), GO, makeSession(), opts(provider));

        // 3 capped iterations + 1 forced wrap-up call.
        expect(provider.calls).toHaveLength(4);
        expect(provider.calls[3]!.tools).toEqual({});

        const last = messages.at(-1)!;
        expect(last.role).toBe("assistant");
        const content = last.content as Exclude<Extract<ModelMessage, { role: "assistant" }>["content"], string>;
        expect(content.some((b) => b.type === "text" && b.text === "here is where I reached")).toBe(true);
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

    it("keeps the transcript valid and marks the tool-calling step when the abort lands during tool execution", async () => {
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

        // The marker rides the tool-calling assistant step, not the tool row.
        const toolCallStep = messages[1]!;
        expect(toolCallStep.role).toBe("assistant");
        expect(isInterruptedMessage(toolCallStep)).toBe(true);

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
    // and, when handed the empty wrap-up tool set, resolves an abort carrying `partial`.
    function abortsAtWrapUp(partial: string): ScriptedProvider {
        return scriptedProvider((callIndex, request) =>
            request.tools !== undefined && Object.keys(request.tools).length === 0
                ? abortedReply(partial)
                : makeMessage([toolUseBlock(`tu-${callIndex}`, "echo", { label: "x" })], "tool_use"),
        );
    }

    it("reports aborted with cappedOut and marks the partial when the wrap-up call aborts", async () => {
        const provider = abortsAtWrapUp("a partial the user cut off at the cap");

        const { messages, finish } = await runAgent(agentDef([echoTool()], 3), GO, makeSession(), opts(provider));

        // The abort during the tool-less wrap-up is reported as aborted; the loop still
        // genuinely exhausted its iterations, so cappedOut stays true.
        expect(finish.reason).toBe("aborted");
        expect(finish.cappedOut).toBe(true);

        // The partial joined the transcript as the tail and carries the interruption marker.
        const last = messages.at(-1)!;
        expect(last.role).toBe("assistant");
        expect(last.content).toBe("a partial the user cut off at the cap");
        expect(isInterruptedMessage(last)).toBe(true);
    });

    it("pushes nothing on an empty wrap-up abort and marks the last tool-calling step", async () => {
        const provider = abortsAtWrapUp("");

        const { messages, finish } = await runAgent(agentDef([echoTool()], 3), GO, makeSession(), opts(provider));

        expect(finish.reason).toBe("aborted");
        expect(finish.cappedOut).toBe(true);

        // No empty assistant shell appended — the tail is the final tool-result message.
        expect(messages.at(-1)!.role).toBe("tool");

        // The marker rides the last assistant step the loop produced (the final tool-calling step).
        const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant")!;
        expect(isInterruptedMessage(lastAssistant)).toBe(true);
    });
});

// ── finish signal on a clean stop ───────────────────────────────────

describe("runAgent — finish signal", () => {
    it("returns the real terminal stop_reason with no recoveries on a clean stop", async () => {
        const provider = scriptedProvider([makeMessage([textBlock("done")], "end_turn")]);

        const { finish } = await runAgent(agentDef([]), GO, makeSession(), opts(provider));

        expect(finish).toEqual({
            reason: "stop",
            cappedOut: false,
            truncationRecoveries: 0,
        });
    });

    it("reports cappedOut with reason max_iterations on the wrap-up path", async () => {
        const provider = scriptedProvider((callIndex, request) =>
            request.tools !== undefined && Object.keys(request.tools).length === 0
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
