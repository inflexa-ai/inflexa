/**
 * The GenAI spans, driven through the provider and the loop the way a host runs
 * them. An in-memory exporter stands in for the OTLP one behind the harness span
 * policy, so each test asserts on exactly what would leave the process. There is
 * one test for each way the spans can go wrong.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { APICallError, type LanguageModelV4, type LanguageModelV4StreamPart, type LanguageModelV4Usage } from "@ai-sdk/provider";
import { context, propagation, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ok } from "neverthrow";
import { z } from "zod";

import type { AgentSession } from "../auth/types.js";
import { finalText, runAgent, type StepNameFormatter } from "../loop/run-agent.js";
import { passthroughStep } from "../loop/run-step.js";
import type { AgentDefinition, LoopMessage, RunStep } from "../loop/types.js";
import { makeSession } from "../providers/__fixtures__/session.js";
import { createAiSdkProvider } from "../providers/ai-sdk.js";
import { createStreamingChat } from "../providers/streaming-chat.js";
import type { ChatRequest } from "../providers/types.js";
import { defineTool, type Tool } from "../tools/define-tool.js";
import { createHarnessSampler, DbosSpanProcessor } from "./otel-spans.js";

// ── A scripted model ────────────────────────────────────────────────

interface Turn {
    readonly text?: string;
    readonly toolCalls?: ReadonlyArray<{ readonly id: string; readonly name: string; readonly input: unknown }>;
    readonly servedModel?: string;
    readonly usage?: LanguageModelV4Usage;
}

/** One answer of the scripted model: a turn, or a failure that the stream call rejects with. */
type Step = Turn | { readonly fail: unknown };

const NO_USAGE: LanguageModelV4Usage = {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
};

/** A model that answers each stream call with the next step of `script`. Both provider entry points stream. */
function scriptedModel(script: readonly Step[]): LanguageModelV4 {
    let next = 0;
    return {
        specificationVersion: "v4",
        provider: "anthropic.messages",
        modelId: "claude-test",
        supportedUrls: {},
        doGenerate: async () => {
            throw new Error("the provider streams every call");
        },
        doStream: async () => {
            const step = script[next++];
            if (step === undefined) throw new Error("the script has no step left");
            if ("fail" in step) throw step.fail;
            const calls = step.toolCalls ?? [];
            const parts: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
            if (step.servedModel !== undefined) parts.push({ type: "response-metadata", modelId: step.servedModel });
            if (step.text !== undefined) {
                parts.push({ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: step.text }, { type: "text-end", id: "t" });
            }
            for (const call of calls) {
                parts.push({ type: "tool-call", toolCallId: call.id, toolName: call.name, input: JSON.stringify(call.input) });
            }
            parts.push({
                type: "finish",
                finishReason: calls.length > 0 ? { unified: "tool-calls", raw: "tool_use" } : { unified: "stop", raw: "end_turn" },
                usage: step.usage ?? NO_USAGE,
            });
            return {
                stream: new ReadableStream<LanguageModelV4StreamPart>({
                    start(controller) {
                        for (const part of parts) controller.enqueue(part);
                        controller.close();
                    },
                }),
            };
        },
    };
}

function providerOf(script: readonly Step[], maxRetries?: number) {
    return createAiSdkProvider({
        model: scriptedModel(script),
        resolveBilling: async () => ({}),
        endpoint: "https://bifrost.internal:8443/v1",
        ...(maxRetries === undefined ? {} : { maxRetries }),
    });
}

/** A 503 that names a zero delay, thus a retry costs no wall-clock time. */
function unavailable(responseBody = "{}"): APICallError {
    return new APICallError({
        message: "upstream unavailable",
        url: "https://bifrost.internal:8443/v1/messages",
        requestBodyValues: {},
        statusCode: 503,
        responseHeaders: { "retry-after-ms": "0" },
        responseBody,
        isRetryable: true,
    });
}

// ── The loop ────────────────────────────────────────────────────────

const REQUEST: ChatRequest = { system: "You are a test model.", messages: [{ role: "user", content: "hello" }], tools: {} };
const GO: readonly LoopMessage[] = [{ role: "user", content: "go" }];

/** The step names of a sandbox step, the durable loop that recovers most often. */
const STEP_NAMES: StepNameFormatter = { llm: (i) => `llm:${i}`, tool: (name, id) => `tool:${name}:${id}` };

function agent(tools: Tool[], systemPrompt = "You are a test agent."): AgentDefinition {
    return { id: "test-agent", systemPrompt, model: "claude-test", tools, maxIterations: 4 };
}

function lookupTool(answer = "an answer"): Tool {
    return defineTool({
        id: "lookup",
        description: "Look a term up.",
        inputSchema: z.object({ query: z.string() }),
        describeCall: "none",
        execute: async () => ok({ answer }),
    });
}

/**
 * A `RunStep` with the replay behaviour of `DBOS.runStep` (`callStepFunction` in
 * `dbos-executor.js`): it opens a `dbos-tracer` span named after the step under
 * the active span. A step with a recorded result marks its span `cached=true`,
 * ends it, and hands the record back without running the body. Every other step
 * runs its body under its span and records the result.
 */
function dbosLikeStep(record: Map<string, unknown>): RunStep {
    return async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        const span = trace.getTracer("dbos-tracer").startSpan(name);
        if (record.has(name)) {
            span.setAttribute("cached", true);
            span.end();
            return record.get(name) as T;
        }
        try {
            const value = await context.with(trace.setSpan(context.active(), span), fn);
            record.set(name, value);
            return value;
        } finally {
            span.end();
        }
    };
}

// ── The exporter ────────────────────────────────────────────────────

let exporter: InMemorySpanExporter;
let tracerProvider: NodeTracerProvider;

function exported(): ReadableSpan[] {
    return exporter.getFinishedSpans();
}

function exportedNames(): string[] {
    return exported()
        .map((span) => span.name)
        .sort();
}

function exportedByName(name: string): ReadableSpan {
    const found = exported().find((span) => span.name === name);
    if (found === undefined) throw new Error(`no exported span named ${name}`);
    return found;
}

/** The names of the exported spans whose parent was not exported: a dropped span that still has a child. */
function orphans(): string[] {
    const ids = new Set(exported().map((span) => span.spanContext().spanId));
    return exported()
        .filter((span) => span.parentSpanContext !== undefined && !ids.has(span.parentSpanContext.spanId))
        .map((span) => span.name);
}

describe("with a tracer provider", () => {
    beforeEach(() => {
        exporter = new InMemorySpanExporter();
        tracerProvider = new NodeTracerProvider({
            sampler: createHarnessSampler(),
            spanProcessors: [new DbosSpanProcessor(new SimpleSpanProcessor(exporter))],
        });
        tracerProvider.register();
    });

    afterEach(async () => {
        await tracerProvider.shutdown();
        trace.disable();
        context.disable();
        propagation.disable();
    });

    it("puts the models, the finish reason, the token counts, and the server of a call on its chat span", async () => {
        const provider = providerOf([
            {
                text: "hi",
                servedModel: "claude-test-20260901",
                usage: {
                    inputTokens: { total: 1200, noCache: 200, cacheRead: 900, cacheWrite: 100 },
                    outputTokens: { total: 80, text: 60, reasoning: 20 },
                },
            },
        ]);

        expect((await provider.chat(REQUEST, makeSession())).isOk()).toBe(true);

        expect(exportedNames()).toEqual(["chat claude-test"]);
        const span = exportedByName("chat claude-test");
        expect(span.kind).toBe(SpanKind.CLIENT);
        expect(span.attributes).toEqual({
            "gen_ai.operation.name": "chat",
            "gen_ai.provider.name": "anthropic",
            "gen_ai.request.model": "claude-test",
            "gen_ai.request.stream": true,
            "server.address": "bifrost.internal",
            "server.port": 8443,
            "gen_ai.response.model": "claude-test-20260901",
            "gen_ai.response.finish_reasons": ["stop"],
            "gen_ai.usage.input_tokens": 1200,
            "gen_ai.usage.output_tokens": 80,
            "gen_ai.usage.cache_read.input_tokens": 900,
            "gen_ai.usage.cache_write.input_tokens": 100,
            "gen_ai.usage.reasoning.output_tokens": 20,
        });
    });

    it("records each retry as an event on the one span of the call, and the class of the failure that ends it", async () => {
        const provider = providerOf([{ fail: unavailable() }, { fail: unavailable() }, { fail: unavailable() }], 2);

        expect((await provider.chat(REQUEST, makeSession())).isErr()).toBe(true);

        expect(exportedNames()).toEqual(["chat claude-test"]);
        const span = exportedByName("chat claude-test");
        expect(span.events.map((event) => [event.name, event.attributes])).toEqual([
            ["retry", { "inflexa.attempt": 1, "inflexa.retry.delay_ms": 0, "http.response.status_code": 503 }],
            ["retry", { "inflexa.attempt": 2, "inflexa.retry.delay_ms": 0, "http.response.status_code": 503 }],
        ]);
        expect(span.status.code).toBe(SpanStatusCode.ERROR);
        expect(span.attributes).toMatchObject({
            "error.type": "provider",
            "http.response.status_code": 503,
            "gen_ai.response.finish_reasons": ["error"],
        });
    });

    it("never puts a prompt, a completion, tool arguments, a tool result, or an error message on a span", async () => {
        const explode = defineTool({
            id: "explode",
            description: "Always throws.",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: async () => {
                throw new Error("SECRET-TOOL-ERROR");
            },
        });
        const chat = createStreamingChat(
            providerOf([
                {
                    toolCalls: [
                        { id: "tc-1", name: "lookup", input: { query: "SECRET-ARGS" } },
                        { id: "tc-2", name: "explode", input: {} },
                    ],
                },
                { fail: unavailable('{"error":{"message":"SECRET-BODY"}}') },
                { text: "SECRET-COMPLETION" },
            ]),
            () => {},
        );

        const result = await runAgent(
            agent([lookupTool("SECRET-RESULT"), explode], "SECRET-SYSTEM"),
            [{ role: "user", content: "SECRET-PROMPT" }],
            makeSession(),
            {
                provider: chat,
                signal: new AbortController().signal,
                emit: () => {},
                runStep: passthroughStep,
            },
        );

        expect(finalText(result.messages)).toBe("SECRET-COMPLETION");
        expect(exportedNames()).toEqual(["chat claude-test", "chat claude-test", "execute_tool explode", "execute_tool lookup", "invoke_agent test-agent"]);
        const everything = JSON.stringify(
            exported().map((span) => ({
                name: span.name,
                attributes: span.attributes,
                events: span.events.map((event) => ({ name: event.name, attributes: event.attributes })),
                status: span.status,
            })),
        );
        expect(everything).not.toContain("SECRET");
    });

    it("emits no span for a call that a recovered workflow replays from its step record", async () => {
        let notesWritten = 0;
        const note = defineTool({
            id: "note",
            description: "Write a note.",
            executionMode: "workflow",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: async () => {
                notesWritten += 1;
                return ok({ written: true });
            },
        });
        const toolRound: Step = {
            toolCalls: [
                { id: "tc-1", name: "lookup", input: { query: "q" } },
                { id: "tc-2", name: "note", input: {} },
            ],
        };
        const session: AgentSession = { ...makeSession(), runFrame: { runId: "run-1", stepId: "qc" } };
        const record = new Map<string, unknown>();
        const run = (script: readonly Step[]) =>
            runAgent(agent([lookupTool(), note]), GO, session, {
                provider: providerOf(script),
                signal: new AbortController().signal,
                emit: () => {},
                runStep: dbosLikeStep(record),
                formatStepName: STEP_NAMES,
            });

        await run([toolRound, { text: "done" }]);

        // One span for each call. Each DBOS step span gave its place to the GenAI
        // span of its body, and no exported span names a dropped parent.
        expect(exportedNames()).toEqual(["chat claude-test", "chat claude-test", "execute_tool lookup", "execute_tool note", "invoke_agent test-agent"]);
        expect(orphans()).toEqual([]);
        expect(exportedByName("invoke_agent test-agent").attributes).toMatchObject({
            "inflexa.run_id": "run-1",
            "inflexa.step_id": "qc",
            "inflexa.agent.iterations": 2,
            "inflexa.agent.capped_out": false,
            "gen_ai.response.finish_reasons": ["stop"],
        });
        expect(exportedByName("execute_tool lookup").attributes).toMatchObject({ "gen_ai.tool.call.id": "tc-1", "inflexa.tool.outcome": "ok" });

        // The process stopped after the tool round, before the second model call
        // was recorded. The recovered workflow replays the first call and the
        // round, and it makes the second call live.
        record.delete("llm:1");
        exporter.reset();
        const recovered = await run([{ text: "done" }]);

        expect(finalText(recovered.messages)).toBe("done");
        // The workflow-mode tool ran again as part of the replay, and it emitted nothing.
        expect(notesWritten).toBe(2);
        expect(exportedNames()).toEqual(["chat claude-test", "invoke_agent test-agent"]);
        expect(orphans()).toEqual([]);
    });
});

describe("without a tracer provider", () => {
    it("runs the loop, its durable steps, and the retry envelope unchanged", async () => {
        // No provider is registered here, as under the CLI embedder: every span
        // the harness asks for is a non-recording one.
        const record = new Map<string, unknown>();
        const result = await runAgent(agent([lookupTool()]), GO, makeSession(), {
            provider: providerOf([{ fail: unavailable() }, { toolCalls: [{ id: "tc-1", name: "lookup", input: { query: "q" } }] }, { text: "done" }]),
            signal: new AbortController().signal,
            emit: () => {},
            runStep: dbosLikeStep(record),
            formatStepName: STEP_NAMES,
        });

        expect(finalText(result.messages)).toBe("done");
        expect(result.finish.reason).toBe("stop");
        expect([...record.keys()]).toEqual(["llm:0", "tool:lookup:tc-1", "llm:1"]);
    });
});
