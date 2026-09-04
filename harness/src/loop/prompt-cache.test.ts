/**
 * Prompt caching through the agent loop: the directive the loop attaches to
 * every request, and the token accounting that comes back.
 *
 * These assert on *state* — the `ChatRequest` values the provider actually
 * received, and the metric values actually exported — never on call counts.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { generateText } from "ai";
import { metrics } from "@opentelemetry/api";
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, type MetricData, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { ok } from "neverthrow";
import { z } from "zod";

import { makeSession } from "../providers/__fixtures__/session.js";
import { createConfiguredAiSdkProvider } from "../providers/ai-sdk.js";
import { DEFAULT_PROMPT_CACHE, promptCacheProviderOptions, withPromptCacheBreakpoint } from "../providers/prompt-cache.js";
import type { ModelMessage, PromptCachePolicy } from "../providers/types.js";
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
    describeCall: "none",
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
    it("marks every vendor that takes an explicit breakpoint", () => {
        expect(DEFAULT_PROMPT_CACHE).toEqual({ ttl: "5m" });
        // Both namespaces ride together: a provider reads only its own key, so
        // the pair costs nothing to whichever one is not serving the call and the
        // placement never has to know which vendor it is talking to.
        expect(promptCacheProviderOptions(DEFAULT_PROMPT_CACHE)).toEqual({
            ...ANTHROPIC_5M,
            bedrock: { cachePoint: { type: "default", ttl: "5m" } },
        });
    });

    it("carries the requested ttl through to each vendor", () => {
        expect(promptCacheProviderOptions({ ttl: "1h" })).toEqual({
            anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
            bedrock: { cachePoint: { type: "default", ttl: "1h" } },
        });
    });

    it("emits no directive at all when caching is off", () => {
        expect(promptCacheProviderOptions("off")).toBeUndefined();
    });
});

// ── Breakpoint placement ────────────────────────────────────────────
//
// The marker has to ride a MESSAGE, never the request: a request-level directive
// reaches the wire as a top-level `cache_control` field, and an intermediary that
// counts blocks to stay under Anthropic's cap of four cannot see one. These
// assert the placement itself, because the failure it prevents is a
// non-retryable 400 that wedges a whole thread.

/** Every message index carrying a cache marker. */
function breakpointsOf(messages: readonly ModelMessage[]): number[] {
    return messages.flatMap((m, i) => (m.providerOptions?.["anthropic"]?.["cacheControl"] === undefined ? [] : [i]));
}

const userText = (text: string): ModelMessage => ({ role: "user", content: [{ type: "text", text }] });
const assistantText = (text: string): ModelMessage => ({ role: "assistant", content: [{ type: "text", text }] });
/** An assistant turn that ends in a thinking block — a block that cannot carry a marker. */
const assistantThinking = (): ModelMessage => ({
    role: "assistant",
    content: [
        { type: "text", text: "answering" },
        { type: "reasoning", text: "deliberating", providerOptions: { anthropic: { signature: "sig-1" } } },
    ],
});

describe("withPromptCacheBreakpoint", () => {
    it("places exactly one breakpoint, on the last message", () => {
        const marked = withPromptCacheBreakpoint([userText("a"), assistantText("b"), userText("c")], DEFAULT_PROMPT_CACHE);

        expect(breakpointsOf(marked)).toEqual([2]);
        expect(marked[2]?.providerOptions?.["anthropic"]?.["cacheControl"]).toEqual({ type: "ephemeral", ttl: "5m" });
    });

    it("carries an explicit ttl onto the message", () => {
        const marked = withPromptCacheBreakpoint([userText("a")], { ttl: "1h" });

        expect(marked[0]?.providerOptions?.["anthropic"]?.["cacheControl"]).toEqual({ type: "ephemeral", ttl: "1h" });
    });

    it("never mutates the caller's array or its messages", () => {
        const transcript = [userText("a"), userText("b")];
        const snapshot = structuredClone(transcript);

        const marked = withPromptCacheBreakpoint(transcript, DEFAULT_PROMPT_CACHE);

        // The transcript is what the loop keeps appending to and the host later
        // persists. A marker written into it would ride into the stored thread and
        // come back on every later turn, one more breakpoint per turn.
        expect(transcript).toEqual(snapshot);
        expect(breakpointsOf(transcript)).toEqual([]);
        expect(marked[1]).not.toBe(transcript[1]);
    });

    it("walks back past an assistant turn that ends in a thinking block", () => {
        // The provider drops a marker on a thinking block: no error, no breakpoint,
        // and a silent miss on every call after it.
        const marked = withPromptCacheBreakpoint([userText("a"), assistantThinking()], DEFAULT_PROMPT_CACHE);

        expect(breakpointsOf(marked)).toEqual([0]);
    });

    it("skips a message with no content to host the marker", () => {
        const empty: ModelMessage = { role: "user", content: [] };

        expect(breakpointsOf(withPromptCacheBreakpoint([userText("a"), empty], DEFAULT_PROMPT_CACHE))).toEqual([0]);
        expect(breakpointsOf(withPromptCacheBreakpoint([{ role: "user", content: "" }, empty], DEFAULT_PROMPT_CACHE))).toEqual([]);
    });

    it("strips a stale marker a stored message carried in, leaving exactly one", () => {
        // `memory/ai-sdk-message-storage.ts` reads `cache_control` back off a stored
        // block, so a row an older build wrote can arrive already marked. Left in
        // place it spends a breakpoint slot the harness never budgeted.
        const stale: ModelMessage = { ...userText("old"), providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } };

        expect(breakpointsOf(withPromptCacheBreakpoint([stale, userText("new")], DEFAULT_PROMPT_CACHE))).toEqual([1]);
    });

    it("strips a stale marker in ANY vendor namespace, not only anthropic", () => {
        // The one-breakpoint invariant is per vendor. A bedrock marker left on an
        // earlier message spends a Bedrock cache point the harness never budgeted,
        // and Anthropic's own count would never notice.
        const stale: ModelMessage = { ...userText("old"), providerOptions: { bedrock: { cachePoint: { type: "default" } } } };

        const marked = withPromptCacheBreakpoint([stale, userText("new")], DEFAULT_PROMPT_CACHE);

        expect(marked[0]?.providerOptions).toEqual({});
        expect(marked[1]?.providerOptions?.["bedrock"]?.["cachePoint"]).toEqual({ type: "default", ttl: "5m" });
    });

    it("keeps the other provider keys of a message it strips", () => {
        const stale: ModelMessage = {
            ...assistantText("old"),
            providerOptions: { anthropic: { cacheControl: { type: "ephemeral" }, signature: "sig-2" }, openai: { store: true } },
        };

        const marked = withPromptCacheBreakpoint([stale, userText("new")], DEFAULT_PROMPT_CACHE);

        expect(marked[0]?.providerOptions).toEqual({ anthropic: { signature: "sig-2" }, openai: { store: true } });
    });

    it("places nothing when caching is off, and strips what a stored message carried", () => {
        const stale: ModelMessage = { ...userText("old"), providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } };

        const marked = withPromptCacheBreakpoint([stale, userText("new")], "off" as PromptCachePolicy);

        expect(breakpointsOf(marked)).toEqual([]);
        // The namespace held nothing else, thus it goes with the marker.
        expect(marked[0]?.providerOptions).toEqual({});
    });

    it("returns the array itself when there is nothing to place and nothing to strip", () => {
        const transcript = [userText("a")];

        expect(withPromptCacheBreakpoint(transcript, "off" as PromptCachePolicy)).toBe(transcript);
        expect(withPromptCacheBreakpoint([], DEFAULT_PROMPT_CACHE)).toEqual([]);
    });
});

describe("runAgent prompt-cache directive", () => {
    it("marks the last message on every iteration, the wrap-up included", async () => {
        const chat = neverTerminating();

        await runAgent(agentDef(3), GO, makeSession(), opts(chat));

        // 3 iterations + the forced tool-less wrap-up.
        expect(chat.calls).toHaveLength(4);
        for (const call of chat.calls) {
            expect(breakpointsOf(call.messages)).toEqual([call.messages.length - 1]);
            expect(call.messages.at(-1)?.providerOptions?.["anthropic"]?.["cacheControl"]).toEqual(ANTHROPIC_5M.anthropic.cacheControl);
        }

        // The wrap-up is the call that empties the tool set — it must still place
        // the breakpoint (its write is the one the cache_write_tokens metric exposes
        // as waste).
        const wrapUp = chat.calls.at(-1)!;
        expect(Object.keys(wrapUp.tools)).toHaveLength(0);
        expect(wrapUp.toolChoice).toBe("none");
        expect(breakpointsOf(wrapUp.messages)).toHaveLength(1);
    });

    it("writes no request-level directive on any call", async () => {
        const chat = neverTerminating();

        await runAgent(agentDef(3), GO, makeSession(), opts(chat));

        // The regression guard. A request-level bag reaches Anthropic as a top-level
        // `cache_control`, which is a breakpoint no intermediary can count —
        // CLIProxyAPI then trims its own markers to four and sends five.
        for (const call of chat.calls) {
            expect(call.providerOptions).toBeUndefined();
        }
    });

    it("rolls the breakpoint forward as the transcript grows", async () => {
        const chat = neverTerminating();

        await runAgent(agentDef(3), GO, makeSession(), opts(chat));

        // Each iteration appends the assistant reply and its tool results, and the
        // breakpoint advances with them: a pinned one would re-process the whole
        // tool transcript uncached on every iteration.
        const marked = chat.calls.map((call) => breakpointsOf(call.messages)[0]!);
        for (let i = 1; i < marked.length; i++) {
            expect(marked[i]!).toBeGreaterThan(marked[i - 1]!);
        }
    });

    it("leaves the transcript it returns unmarked", async () => {
        const chat = neverTerminating();

        const result = await runAgent(agentDef(3), GO, makeSession(), opts(chat));

        // The host persists this array. A marker in it would be stored and replayed.
        expect(breakpointsOf(result.messages)).toEqual([]);
    });

    it("honours an explicit 1h policy from the composition root", async () => {
        const chat = neverTerminating();

        await runAgent(agentDef(2), GO, makeSession(), opts(chat, { promptCache: { ttl: "1h" } }));

        for (const call of chat.calls) {
            expect(call.messages.at(-1)?.providerOptions?.["anthropic"]?.["cacheControl"]).toEqual({ type: "ephemeral", ttl: "1h" });
        }
    });

    it("sends no directive when the host turns caching off", async () => {
        const chat = neverTerminating();

        await runAgent(agentDef(2), GO, makeSession(), opts(chat, { promptCache: "off" as PromptCachePolicy }));

        expect(chat.calls).toHaveLength(3);
        // Caching off leaves no marker anywhere and no bag at all. The reasoning
        // depth rides on its own neutral field, thus it writes no vendor key here.
        for (const call of chat.calls) {
            expect(breakpointsOf(call.messages)).toEqual([]);
            expect(call.providerOptions).toBeUndefined();
            expect(call.reasoning).toBe("xhigh");
        }
    });
});

describe("runAgent reasoning directive", () => {
    it("carries the neutral depth on every call, and writes no vendor key for it", async () => {
        const chat = neverTerminating();

        await runAgent(agentDef(3), GO, makeSession(), opts(chat));

        expect(chat.calls).toHaveLength(4);
        for (const call of chat.calls) {
            expect(call.reasoning).toBe("xhigh");
            // The vendor key is what turned the per-model table of the provider
            // package off, thus nothing may write it again.
            expect(call.providerOptions?.["anthropic"]?.["effort"]).toBeUndefined();
            expect(call.providerOptions?.["openai"]).toBeUndefined();
        }
    });

    it("honours an explicit depth from the composition root", async () => {
        const chat = neverTerminating();

        await runAgent(agentDef(2), GO, makeSession(), opts(chat, { reasoning: "low" }));

        for (const call of chat.calls) {
            expect(call.reasoning).toBe("low");
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
 * A canned OpenAI chat-completions stream. `prompt_tokens_details.cached_tokens`
 * is the OpenAI-family cache-read report — the provider normalizes it onto the
 * same neutral field the Anthropic provider uses.
 */
function cannedOpenAiFetch(seen: Record<string, unknown>[]): typeof fetch {
    return (async (_input: string | URL | Request, init?: RequestInit) => {
        seen.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        const base = { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1_700_000_000, model: "local-model" };
        const body = [
            `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] })}\n\n`,
            `data: ${JSON.stringify({
                ...base,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 100, completion_tokens: 7, total_tokens: 107, prompt_tokens_details: { cached_tokens: 80 } },
            })}\n\n`,
            "data: [DONE]\n\n",
        ].join("");
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
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
        // namespaced bag, so no vendor cache marker appears in the request body.
        expect(bodies).toHaveLength(1);
        expect(JSON.stringify(bodies[0])).not.toContain("cache_control");
        expect(JSON.stringify(bodies[0])).not.toContain("cacheControl");
        expect(JSON.stringify(bodies[0])).not.toContain("cachePoint");
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

// ── The Bedrock marker, rendered by the real provider ───────────────
//
// The one placement carries a marker for both vendors that need one. Anthropic
// and Bedrock disagree on more than spelling — Anthropic marks the last content
// block of the message, Bedrock appends a `cachePoint` block after it — so the
// only honest check is what the provider actually renders. `@ai-sdk/amazon-bedrock`
// exports no type for the `cachePoint` value and forwards it to AWS verbatim,
// thus a wrong shape here would reach the wire unchecked and nothing upstream
// would catch it.

/** A canned Bedrock Converse response — enough for the provider to parse a reply. */
function cannedBedrockFetch(seen: Record<string, unknown>[]): typeof fetch {
    return (async (_input: string | URL | Request, init?: RequestInit) => {
        seen.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
            JSON.stringify({
                output: { message: { role: "assistant", content: [{ text: "ok" }] } },
                stopReason: "end_turn",
                usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
        );
    }) as typeof fetch;
}

describe("the bedrock marker on the wire", () => {
    /** The content blocks Bedrock renders for the last message of the request. */
    async function lastMessageBlocks(policy: PromptCachePolicy): Promise<Record<string, unknown>[]> {
        const bodies: Record<string, unknown>[] = [];
        const bedrock = createAmazonBedrock({ region: "us-east-1", apiKey: "test-key", fetch: cannedBedrockFetch(bodies) });

        await generateText({
            model: bedrock("anthropic.claude-sonnet-5"),
            messages: [...withPromptCacheBreakpoint([userText("first"), assistantText("second"), userText("third")], policy)],
        });

        const messages = (bodies[0]?.["messages"] ?? []) as { content: Record<string, unknown>[] }[];
        return messages.at(-1)?.content ?? [];
    }

    it("appends a cachePoint block after the last message, carrying the ttl", async () => {
        const blocks = await lastMessageBlocks(DEFAULT_PROMPT_CACHE);

        // Appended AFTER the text, not merged into it — that is Bedrock's shape.
        expect(blocks.at(-1)).toEqual({ cachePoint: { type: "default", ttl: "5m" } });
        expect(blocks.at(-2)).toEqual({ text: "third" });
    });

    it("carries an explicit 1h ttl", async () => {
        expect((await lastMessageBlocks({ ttl: "1h" })).at(-1)).toEqual({ cachePoint: { type: "default", ttl: "1h" } });
    });

    it("renders no cachePoint at all when caching is off", async () => {
        const blocks = await lastMessageBlocks("off" as PromptCachePolicy);

        expect(blocks.some((b) => "cachePoint" in b)).toBe(false);
    });
});
