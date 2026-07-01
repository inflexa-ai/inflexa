/**
 * Agent-loop OTel metrics → Middleware.io.
 *
 * Every `runAgent` completion records two signals:
 *   - cortex.harness.agent.iterations — histogram of LLM iterations per run.
 *     A creeping distribution is a leading indicator of prompt drift.
 *   - cortex.harness.agent.cap_hits   — counter, incremented once per run
 *     that exhausted `maxIterations` and took the forced wrap-up path.
 *
 * Instruments are created lazily on first use so the loop binds to whatever
 * `MeterProvider` is registered globally at runtime (production: the OTLP
 * exporter from `harness/lib/otel.ts`; tests: an in-memory reader).
 */

import { type Counter, type Histogram, metrics } from "@opentelemetry/api";

interface Instruments {
    readonly iterations: Histogram;
    readonly capHits: Counter;
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
        };
    }
    return instruments;
}

/** Record one completed `runAgent` invocation. */
export function recordAgentRun(run: { readonly agentId: string; readonly iterations: number; readonly cappedOut: boolean }): void {
    const { iterations, capHits } = getInstruments();
    const attributes = { agent_id: run.agentId };
    iterations.record(run.iterations, attributes);
    if (run.cappedOut) capHits.add(1, attributes);
}

/**
 * Drop the memoized instruments so the next `recordAgentRun` rebinds to a
 * freshly-registered `MeterProvider`. Test-only — production registers its
 * provider once at startup.
 */
export function __resetMetricsForTest(): void {
    instruments = undefined;
}
