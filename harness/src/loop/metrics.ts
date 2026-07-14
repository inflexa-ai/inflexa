/**
 * Agent-loop OTel metrics → Middleware.io.
 *
 * Every `runAgent` completion records, keyed by `agent_id`:
 *   - cortex.harness.agent.iterations — histogram of LLM iterations per run.
 *     A creeping distribution is a leading indicator of prompt drift.
 *   - cortex.harness.agent.cap_hits   — counter, incremented once per run
 *     that exhausted `maxIterations` and took the forced wrap-up path.
 *   - cortex.harness.agent.input_tokens / .output_tokens — counters, summed
 *     over every LLM call the run made (the wrap-up included).
 *   - cortex.harness.agent.cache_read_tokens  — counter, prefix tokens served
 *     from the prompt cache.
 *   - cortex.harness.agent.cache_write_tokens — counter, prefix tokens written
 *     into it (billed at a premium; only pays off once something reads it).
 *
 * The two cache counters are what make prompt caching *observable*: the hit
 * rate for an agent type is `cache_read_tokens / input_tokens` (the harness's
 * `inputTokens` is the total billed prefix, cache reads included). A flat-zero
 * `cache_read_tokens` against a non-zero `cache_write_tokens` means every write
 * is being thrown away — either a cache defeater is shifting the prefix (see
 * `providers/prompt-cache.ts`) or the endpoint ignores cache directives
 * outright, as the Claude Max OAuth path does.
 *
 * Token counters are recorded only from what a provider actually reports; a
 * provider that reports no usage contributes nothing rather than zero.
 *
 * Instruments are created lazily on first use so the loop binds to whatever
 * `MeterProvider` is registered globally at runtime (production: the OTLP
 * exporter from `harness/lib/otel.ts`; tests: an in-memory reader).
 */

import { type Counter, type Histogram, metrics } from "@opentelemetry/api";

import type { ChatUsage } from "../providers/types.js";

interface Instruments {
    readonly iterations: Histogram;
    readonly capHits: Counter;
    readonly inputTokens: Counter;
    readonly outputTokens: Counter;
    readonly cacheReadTokens: Counter;
    readonly cacheWriteTokens: Counter;
}

let instruments: Instruments | undefined;

function getInstruments(): Instruments {
    if (instruments === undefined) {
        const meter = metrics.getMeter("cortex.harness.loop");
        instruments = {
            iterations: meter.createHistogram("cortex.harness.agent.iterations", {
                description: "LLM iterations executed per runAgent completion",
                unit: "{iteration}",
            }),
            capHits: meter.createCounter("cortex.harness.agent.cap_hits", {
                description: "runAgent completions that exhausted maxIterations and took the " + "forced tool-less wrap-up path",
            }),
            inputTokens: meter.createCounter("cortex.harness.agent.input_tokens", {
                description: "Input tokens billed across every LLM call in a runAgent completion, cache reads included",
                unit: "{token}",
            }),
            outputTokens: meter.createCounter("cortex.harness.agent.output_tokens", {
                description: "Output tokens generated across every LLM call in a runAgent completion",
                unit: "{token}",
            }),
            cacheReadTokens: meter.createCounter("cortex.harness.agent.cache_read_tokens", {
                description: "Prompt-prefix tokens served from the provider's prompt cache",
                unit: "{token}",
            }),
            cacheWriteTokens: meter.createCounter("cortex.harness.agent.cache_write_tokens", {
                description: "Prompt-prefix tokens written into the provider's prompt cache",
                unit: "{token}",
            }),
        };
    }
    return instruments;
}

/**
 * Token usage summed over every LLM call one `runAgent` made. Each field stays
 * `undefined` until some call actually reports it, so "the provider told us
 * nothing" never masquerades as a measured zero.
 */
export interface AgentRunUsage {
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
}

/** Fold one call's reported usage into a run's running total. */
export function addChatUsage(total: AgentRunUsage, usage: ChatUsage | undefined): void {
    if (usage === undefined) return;
    for (const key of ["inputTokens", "outputTokens", "cacheCreationInputTokens", "cacheReadInputTokens"] as const) {
        const value = usage[key];
        if (value !== undefined) total[key] = (total[key] ?? 0) + value;
    }
}

/** Record one completed `runAgent` invocation. */
export function recordAgentRun(run: {
    readonly agentId: string;
    readonly iterations: number;
    readonly cappedOut: boolean;
    readonly usage?: AgentRunUsage;
}): void {
    const { iterations, capHits, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = getInstruments();
    const attributes = { agent_id: run.agentId };
    iterations.record(run.iterations, attributes);
    if (run.cappedOut) capHits.add(1, attributes);

    const usage = run.usage;
    if (usage === undefined) return;
    if (usage.inputTokens !== undefined) inputTokens.add(usage.inputTokens, attributes);
    if (usage.outputTokens !== undefined) outputTokens.add(usage.outputTokens, attributes);
    if (usage.cacheReadInputTokens !== undefined) cacheReadTokens.add(usage.cacheReadInputTokens, attributes);
    if (usage.cacheCreationInputTokens !== undefined) cacheWriteTokens.add(usage.cacheCreationInputTokens, attributes);
}

/**
 * Drop the memoized instruments so the next `recordAgentRun` rebinds to a
 * freshly-registered `MeterProvider`. Test-only — production registers its
 * provider once at startup.
 */
export function __resetMetricsForTest(): void {
    instruments = undefined;
}
