/**
 * Prompt caching through the agent loop: the directive the loop attaches to
 * every request, and the token accounting that comes back.
 *
 * These assert on *state* — the `ChatRequest` values the provider actually
 * received, and the metric values actually exported — never on call counts.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { metrics } from "@opentelemetry/api";
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, type MetricData, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { ok } from "neverthrow";
import { z } from "zod";

import { makeSession } from "../providers/__fixtures__/session.js";
import { createConfiguredAiSdkProvider } from "../providers/ai-sdk.js";
import { DEFAULT_PROMPT_CACHE, promptCacheProviderOptions } from "../providers/prompt-cache.js";
import type { PromptCachePolicy } from "../providers/types.js";
import { defineTool } from "../tools/define-tool.js";
import { makeMessage, scriptedProvider, type ScriptedProvider, textBlock, toolUseBlock } from "./__fixtures__/scripted-provider.js";
import { __resetMetricsForTest } from "./metrics.js";
import { runAgent, type RunAgentOptions } from "./run-agent.js";
import { passthroughStep } from "./run-step.js";
import type { AgentDefinition } from "./types.js";

const ANTHROPIC_5M = { anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } } };

const echoTool = defineTool({
    id: "echo",
    description: "A no-op tool.",
    inputSchema: z.object({}),
    execute: async () => ok({ ok: true }),
});

function agentDef(maxIterations = 8): AgentDefinition {
    return {
        id: "cache-agent",
        systemPrompt: "You are a test agent.",
        model: "claude-test",
        tools: [echoTool],
        maxIterations,
    };
}

const GO = [{ role: "user" as const, content: "go" }];

function opts(provider: RunAgentOptions["provider"], overrides: Partial<RunAgentOptions> = {}): RunAgentOptions {
    return {
        provider,
        signal: new AbortController().signal,
        emit: () => {},
        runStep: passthroughStep,
        ...overrides,
    };
}

/** A script that never terminates on its own, forcing the loop to the wrap-up call. */
function neverTerminating(): ScriptedProvider {
    return scriptedProvider(() => makeMessage([toolUseBlock("t", "echo", {})], "tool_use"));
}

describe("promptCacheProviderOptions", () => {
    it("defaults to the 5m ephemeral policy", () => {
        expect(DEFAULT_PROMPT_CACHE).toEqual({ ttl: "5m" });
        expect(promptCacheProviderOptions(DEFAULT_PROMPT_CACHE)).toEqual(ANTHROPIC_5M);
    });

    it("carries the requested ttl through", () => {
        expect(promptCacheProviderOptions({ ttl: "1h" })).toEqual({
            anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
        });
    });

    it("emits no directive at all when caching is off", () => {
        expect(promptCacheProviderOptions("off")).toBeUndefined();
    });
});

describe("runAgent prompt-cache directive", () => {
    it("attaches the default 5m directive to every iteration, the wrap-up included", async () => {
        const chat = neverTerminating();

        await runAgent(agentDef(3), GO, makeSession(), opts(chat));

        // 3 iterations + the forced tool-less wrap-up.
        expect(chat.calls).toHaveLength(4);
        for (const call of chat.calls) {
            expect(call.providerOptions).toEqual(ANTHROPIC_5M);
        }

        // The wrap-up is the call that empties the tool set — it must still carry
        // the directive (its write is the one the cache_write_tokens metric exposes
        // as waste).
        const wrapUp = chat.calls.at(-1)!;
        expect(Object.keys(wrapUp.tools)).toHaveLength(0);
        expect(wrapUp.toolChoice).toBe("none");
        expect(wrapUp.providerOptions).toEqual(ANTHROPIC_5M);
    });

    it("sends the same directive object on every call, so the prefix stays byte-identical", async () => {
        const chat = neverTerminating();

        await runAgent(agentDef(3), GO, makeSession(), opts(chat));

        const first = chat.calls[0]!.providerOptions;
        for (const call of chat.calls) {
            expect(call.providerOptions).toBe(first);
        }
    });

    it("honours an explicit 1h policy from the composition root", async () => {
        const chat = neverTerminating();

        await runAgent(agentDef(2), GO, makeSession(), opts(chat, { promptCache: { ttl: "1h" } }));

        for (const call of chat.calls) {
            expect(call.providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } });
        }
    });

    it("sends no directive when the host turns caching off", async () => {
        const chat = neverTerminating();

        await runAgent(agentDef(2), GO, makeSession(), opts(chat, { promptCache: "off" as PromptCachePolicy }));

        expect(chat.calls).toHaveLength(3);
        for (const call of chat.calls) {
            expect(call.providerOptions).toBeUndefined();
        }
    });
});

// ── Usage → metrics ─────────────────────────────────────────────────

const INPUT_TOKENS_METRIC = "cortex.harness.agent.input_tokens";
const OUTPUT_TOKENS_METRIC = "cortex.harness.agent.output_tokens";
const CACHE_READ_METRIC = "cortex.harness.agent.cache_read_tokens";
const CACHE_WRITE_METRIC = "cortex.harness.agent.cache_write_tokens";

describe("runAgent cache-token metrics", () => {
    let exporter: InMemoryMetricExporter;
    let provider: MeterProvider;

    beforeEach(() => {
        exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
        const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
        provider = new MeterProvider({ readers: [reader] });
        metrics.setGlobalMeterProvider(provider);
        __resetMetricsForTest();
    });

    afterEach(async () => {
        await provider.shutdown();
        metrics.disable();
        __resetMetricsForTest();
    });

    async function collectMetrics(): Promise<MetricData[]> {
        await provider.forceFlush();
        return exporter
            .getMetrics()
            .flatMap((rm) => rm.scopeMetrics)
            .flatMap((sm) => sm.metrics);
    }

    /** Sum a counter's data points, optionally for one `agent_id`. */
    async function counterTotal(name: string, agentId?: string): Promise<number | undefined> {
        const metric = (await collectMetrics()).find((m) => m.descriptor.name === name);
        if (metric === undefined) return undefined;
        return metric.dataPoints.filter((dp) => agentId === undefined || dp.attributes.agent_id === agentId).reduce((acc, dp) => acc + (dp.value as number), 0);
    }

    it("sums usage across every iteration of a run and reports it per agent", async () => {
        const chat = scriptedProvider([
            makeMessage([toolUseBlock("t0", "echo", {})], "tool_use", {
                inputTokens: 1000,
                outputTokens: 20,
                cacheCreationInputTokens: 900,
                cacheReadInputTokens: 0,
            }),
            makeMessage([toolUseBlock("t1", "echo", {})], "tool_use", {
                inputTokens: 1100,
                outputTokens: 30,
                cacheCreationInputTokens: 100,
                cacheReadInputTokens: 900,
            }),
            makeMessage([textBlock("done")], "end_turn", {
                inputTokens: 1200,
                outputTokens: 40,
                cacheCreationInputTokens: 0,
                cacheReadInputTokens: 1000,
            }),
        ]);

        await runAgent(agentDef(8), GO, makeSession(), opts(chat));

        // Round-trip: provider usage → ChatResponse.usage → metrics, keyed by agent.
        expect(await counterTotal(INPUT_TOKENS_METRIC, "cache-agent")).toBe(3300);
        expect(await counterTotal(OUTPUT_TOKENS_METRIC, "cache-agent")).toBe(90);
        expect(await counterTotal(CACHE_READ_METRIC, "cache-agent")).toBe(1900);
        expect(await counterTotal(CACHE_WRITE_METRIC, "cache-agent")).toBe(1000);
    });

    it("counts the wrap-up call's tokens too", async () => {
        const usage = { inputTokens: 500, outputTokens: 10, cacheCreationInputTokens: 500, cacheReadInputTokens: 0 };
        const chat = scriptedProvider(() => makeMessage([toolUseBlock("t", "echo", {})], "tool_use", usage));

        await runAgent(agentDef(2), GO, makeSession(), opts(chat));

        // 2 iterations + wrap-up = 3 calls, all reporting the same usage.
        expect(chat.calls).toHaveLength(3);
        expect(await counterTotal(INPUT_TOKENS_METRIC, "cache-agent")).toBe(1500);
        expect(await counterTotal(CACHE_WRITE_METRIC, "cache-agent")).toBe(1500);
    });

    it("records nothing rather than a false zero when the provider reports no usage", async () => {
        const chat = scriptedProvider([makeMessage([textBlock("done")], "end_turn")]);

        await runAgent(agentDef(8), GO, makeSession(), opts(chat));

        // Absent means "not reported" — the counters must not have been touched.
        expect(await counterTotal(INPUT_TOKENS_METRIC)).toBeUndefined();
        expect(await counterTotal(CACHE_READ_METRIC)).toBeUndefined();
    });

    it("keeps each agent's cache accounting separate", async () => {
        const usage = { inputTokens: 100, outputTokens: 5, cacheReadInputTokens: 80 };
        const chat = scriptedProvider(() => makeMessage([textBlock("done")], "end_turn", usage));

        await runAgent({ ...agentDef(4), id: "agent-a" }, GO, makeSession(), opts(chat));
        await runAgent({ ...agentDef(4), id: "agent-b" }, GO, makeSession(), opts(chat));
        await runAgent({ ...agentDef(4), id: "agent-b" }, GO, makeSession(), opts(chat));

        expect(await counterTotal(CACHE_READ_METRIC, "agent-a")).toBe(80);
        expect(await counterTotal(CACHE_READ_METRIC, "agent-b")).toBe(160);
    });
});

// ── The openai-compatible no-op ─────────────────────────────────────

/**
 * A canned OpenAI chat-completions response. `prompt_tokens_details.cached_tokens`
 * is the OpenAI-family cache-read report — the provider normalizes it onto the
 * same neutral field the Anthropic provider uses.
 */
function cannedOpenAiFetch(seen: Record<string, unknown>[]): typeof fetch {
    return (async (_input: string | URL | Request, init?: RequestInit) => {
        seen.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
            JSON.stringify({
                id: "chatcmpl-1",
                object: "chat.completion",
                created: 1_700_000_000,
                model: "local-model",
                choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
                usage: {
                    prompt_tokens: 100,
                    completion_tokens: 7,
                    total_tokens: 107,
                    prompt_tokens_details: { cached_tokens: 80 },
                },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
        );
    }) as typeof fetch;
}

describe("prompt caching against an openai-compatible provider", () => {
    it("passes the anthropic directive through inertly — a no-op, never an error", async () => {
        const bodies: Record<string, unknown>[] = [];
        const provider = createConfiguredAiSdkProvider({
            config: {
                kind: "openai-compatible",
                name: "self-hosted",
                baseURL: "http://models.local/v1",
                apiKey: "test-key",
                model: "local-model",
                fetch: cannedOpenAiFetch(bodies),
            },
            resolveBilling: async () => ({}),
        });

        const result = await runAgent(agentDef(4), GO, makeSession(), opts(provider));

        // The run completed normally: the foreign `anthropic` namespace was ignored
        // by the provider rather than rejected.
        expect(result.finish.reason).toBe("stop");
        expect(result.finish.cappedOut).toBe(false);

        // And it never reached the wire — `providerOptions` is a client-side
        // namespaced bag, so nothing anthropic-shaped appears in the request body.
        expect(bodies).toHaveLength(1);
        expect(JSON.stringify(bodies[0])).not.toContain("cache_control");
        expect(JSON.stringify(bodies[0])).not.toContain("cacheControl");
    });

    it("reports openai-family cached tokens on the same neutral usage field", async () => {
        const provider = createConfiguredAiSdkProvider({
            config: {
                kind: "openai-compatible",
                name: "self-hosted",
                baseURL: "http://models.local/v1",
                apiKey: "test-key",
                model: "local-model",
                fetch: cannedOpenAiFetch([]),
            },
            resolveBilling: async () => ({}),
        });

        const reply = (await provider.chat({ system: "s", messages: GO, tools: {} }, makeSession()))._unsafeUnwrap();

        expect(reply.usage).toMatchObject({
            inputTokens: 100,
            outputTokens: 7,
            cacheReadInputTokens: 80,
        });
        // That family bills no separate cache write.
        expect(reply.usage?.cacheCreationInputTokens).toBeUndefined();
    });
});
