import { afterAll, beforeAll, expect, it } from "bun:test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { context, propagation, SpanStatusCode, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { ok } from "neverthrow";
import { z } from "zod";

import { makeSession } from "../providers/__fixtures__/session.js";
import { createAiSdkProvider } from "../providers/ai-sdk.js";
import type { SandboxClient } from "../sandbox/client.js";
import type { ExecResult, SandboxRef } from "../sandbox/types.js";
import { defineTool } from "../tools/define-tool.js";
import { createExecuteCommandTool } from "../tools/workspace/execute-command.js";
import { makeMessage, scriptedProvider, textBlock, toolUseBlock } from "./__fixtures__/scripted-provider.js";
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

const sandbox: SandboxRef = { sandboxId: "sb-1", host: "127.0.0.1", port: 8765, backend: "docker", callbackSecret: "secret" };

/** A sandbox client whose every exec settles to `result`. */
function settlingClient(result: Omit<ExecResult, "execId">): SandboxClient {
    return {
        toolchainSource: "store",
        createSandbox: async () => sandbox,
        submitExec: async () => {},
        awaitExec: async (_ref, execId) => ({ ...result, execId }),
        isAlive: async () => ({ alive: true, oomKilled: false }),
        isAliveById: async () => ({ alive: true, oomKilled: false }),
        teardown: async () => {},
        teardownById: async () => {},
        listManagedSandboxes: async () => [],
    };
}

/** Run one `execute_command` call whose exec settles to `result`, and give the span of that call. */
async function execSpan(toolCallId: string, result: Omit<ExecResult, "execId">): Promise<ReadableSpan> {
    const executeCommand = createExecuteCommandTool({
        sandboxClient: settlingClient(result),
        sandbox,
        workflowId: "wf",
        stepId: "step",
        nextFunctionId: () => toolCallId,
        deadlineMs: () => Date.now() + 60_000,
        defaultCwd: "/analysis/runs/run/step",
    });
    const provider = scriptedProvider([
        makeMessage([toolUseBlock(toolCallId, "execute_command", { command: ["python", "run.py"] })], "tool_use"),
        makeMessage([textBlock("done")], "end_turn"),
    ]);

    await runAgent(
        { id: "test-agent", systemPrompt: "system", model: "mock-model-id", tools: [executeCommand], maxIterations: 4 },
        [{ role: "user", content: "go" }],
        makeSession(),
        { provider, signal: new AbortController().signal, emit: () => {}, runStep: passthroughStep },
    );

    const span = exporter.getFinishedSpans().find((finished) => finished.attributes["gen_ai.tool.call.id"] === toolCallId);
    expect(span).toBeDefined();
    return span!;
}

it("records a returned non-zero exec as an error, with its exit code and a capped stderr tail, and no stdout", async () => {
    const stderr = `${Array.from({ length: 200 }, (_, line) => `E${line}`).join("\n")}\n`;
    const span = await execSpan("tc-nonzero", { exitCode: 1, stdout: "STDOUT-TEXT", stderr, durationMs: 5, timedOut: false });

    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes["error.type"]).toBe("nonzero");
    expect(span.attributes["inflexa.sandbox.exit_code"]).toBe(1);
    const tail = String(span.attributes["inflexa.sandbox.stderr_tail"]);
    expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(2_048);
    expect(tail.trimEnd().split("\n").length).toBeLessThanOrEqual(80);
    expect(tail.trimEnd().endsWith("E199")).toBe(true);
    expect(JSON.stringify([span.attributes, span.events, span.status])).not.toContain("STDOUT-TEXT");
});

it("flags a stderr past the 32 KiB cap as head-only, and keeps its tail within the cap", async () => {
    const line = `${"x".repeat(99)}\n`;
    const span = await execSpan("tc-head-only", { exitCode: 1, stdout: "", stderr: line.repeat(410), durationMs: 5, timedOut: false });

    expect(span.attributes["inflexa.sandbox.stderr_head_only"]).toBe(true);
    expect(Buffer.byteLength(String(span.attributes["inflexa.sandbox.stderr_tail"]), "utf8")).toBeLessThanOrEqual(2_048);
});
