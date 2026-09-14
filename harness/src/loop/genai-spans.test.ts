import { afterAll, beforeAll, expect, it } from "bun:test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { context, propagation, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { ok } from "neverthrow";
import { z } from "zod";

import { makeSession } from "../providers/__fixtures__/session.js";
import { createAiSdkProvider } from "../providers/ai-sdk.js";
import { defineTool } from "../tools/define-tool.js";
import { runAgent } from "./run-agent.js";
import { passthroughStep } from "./run-step.js";

const exporter = new InMemorySpanExporter();
const tracerProvider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

beforeAll(() => tracerProvider.register());

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
