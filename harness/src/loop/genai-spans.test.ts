import { afterAll, beforeAll, beforeEach, expect, it } from "bun:test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { context, propagation, SpanStatusCode, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { err, ok } from "neverthrow";
import { z } from "zod";

import { makeSession } from "../providers/__fixtures__/session.js";
import { createAiSdkProvider } from "../providers/ai-sdk.js";
import { defineTool, type Tool } from "../tools/define-tool.js";
import { makeMessage, scriptedProvider, textBlock, toolUseBlock } from "./__fixtures__/scripted-provider.js";
import { runAgent } from "./run-agent.js";
import { passthroughStep } from "./run-step.js";

const exporter = new InMemorySpanExporter();
const tracerProvider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

beforeAll(() => tracerProvider.register());

beforeEach(() => exporter.reset());

afterAll(async () => {
    await tracerProvider.shutdown();
    trace.disable();
    context.disable();
    propagation.disable();
});

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };

const reply = (...parts: LanguageModelV4StreamPart[]) => ({
    stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([{ type: "stream-start", warnings: [] }, ...parts]),
});

const lookup = defineTool({
    id: "lookup",
    description: "Look a term up.",
    inputSchema: z.object({ query: z.string() }),
    describeCall: "none",
    execute: async () => ok({ answer: "SECRET-RESULT" }),
});

it("exports the loop and model-call spans as one trace, with no prompt or completion text", async () => {
    const model = new MockLanguageModelV4({
        doStream: [
            reply(
                { type: "tool-call", toolCallId: "tc-1", toolName: "lookup", input: JSON.stringify({ query: "SECRET-ARGS" }) },
                { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
            ),
            reply(
                { type: "text-start", id: "t" },
                { type: "text-delta", id: "t", delta: "SECRET-COMPLETION" },
                { type: "text-end", id: "t" },
                { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
            ),
        ],
    });

    await runAgent(
        { id: "test-agent", systemPrompt: "SECRET-SYSTEM", model: "mock-model-id", tools: [lookup], maxIterations: 4 },
        [{ role: "user", content: "SECRET-PROMPT" }],
        makeSession(),
        {
            provider: createAiSdkProvider({ model, resolveBilling: async () => ({}) }),
            signal: new AbortController().signal,
            emit: () => {},
            runStep: passthroughStep,
        },
    );

    const spans = exporter.getFinishedSpans();
    expect(spans.map((span) => span.name)).toEqual(expect.arrayContaining(["invoke_agent test-agent", "chat mock-model-id", "execute_tool lookup"]));
    expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(1);
    expect(JSON.stringify(spans.map((span) => [span.attributes, span.events, span.status]))).not.toContain("SECRET");
});

/** Run one scripted call of `tool`, and give back its `execute_tool` span. */
async function executeToolSpan(tool: Tool, toolCallId: string, input: unknown): Promise<ReadableSpan> {
    const provider = scriptedProvider([makeMessage([toolUseBlock(toolCallId, tool.id, input)], "tool_use"), makeMessage([textBlock("done")], "end_turn")]);
    await runAgent(
        { id: "test-agent", systemPrompt: "You are a test agent.", model: "claude-test", tools: [tool], maxIterations: 4 },
        [{ role: "user", content: "go" }],
        makeSession(),
        { provider, signal: new AbortController().signal, emit: () => {}, runStep: passthroughStep },
    );
    const span = exporter.getFinishedSpans().find((finished) => finished.attributes["gen_ai.tool.call.id"] === toolCallId);
    if (span === undefined) throw new Error(`no execute_tool span for ${toolCallId}`);
    return span;
}

it("records an exception that a tool throws on its execute_tool span", async () => {
    const boom = defineTool({
        id: "boom",
        description: "Always throws.",
        inputSchema: z.object({}),
        describeCall: "none",
        execute: async () => {
            throw new TypeError("kaboom");
        },
    });

    const span = await executeToolSpan(boom, "tc-throw", {});

    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes["error.type"]).toBe("TypeError");
    expect(span.events.find((event) => event.name === "exception")?.attributes?.["exception.message"]).toBe("kaboom");
});

it("labels rejected input on the span with no text of the input", async () => {
    const strict = defineTool({
        id: "strict",
        description: "Takes one number.",
        inputSchema: z.strictObject({ n: z.number() }),
        describeCall: "none",
        execute: async () => ok({}),
    });

    // Zod quotes an unrecognized key in its message.
    const span = await executeToolSpan(strict, "tc-invalid", { n: 1, SECRET: "x" });

    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes["error.type"]).toBe("validation");
    expect(span.attributes["inflexa.tool.error"]).toBeUndefined();
    expect(JSON.stringify([span.attributes, span.events, span.status])).not.toContain("SECRET");
});

it("labels an err(ToolError) with its text and records no exception", async () => {
    const down = defineTool({
        id: "down",
        description: "Returns an err Result.",
        inputSchema: z.object({}),
        describeCall: "none",
        execute: async () => err({ error: "upstream down", retryable: true } as const),
    });

    const span = await executeToolSpan(down, "tc-err", {});

    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes["error.type"]).toBe("tool_error");
    expect(span.attributes["inflexa.tool.error"]).toBe("upstream down");
    expect(span.events.some((event) => event.name === "exception")).toBe(false);
});
