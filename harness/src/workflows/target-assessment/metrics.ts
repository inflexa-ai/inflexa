/**
 * OpenTelemetry counters for the target-assessment DBOS workflow.
 *
 * Surfaces three signals:
 *  - `cortex.harness.ta.workflow.terminal_reason` — per terminal path; the
 *    alert in §16.5/§16.6 reads this. `reason` ∈ {completed,
 *    target-unresolved, schema-violation, derived-invariant-violation,
 *    unexpected-throw, suspended-on-402, operator-cancelled}.
 *  - `cortex.harness.ta.llm.attempts` — histogram per LLM step (caller
 *    samples on entry to detect probe-retry loops).
 *  - billing cache_hit/_miss live in `harness/billing/target-assessment-resolver.ts`.
 *
 * Memoised meter so a re-imported module in tests doesn't recreate the
 * instruments against the same MeterProvider (which would log noisy
 * "duplicate instrument" warnings).
 */

import { metrics, type Counter, type Histogram } from "@opentelemetry/api";

export type TaTerminalReason =
    | "completed"
    | "target-unresolved"
    | "schema-violation"
    | "derived-invariant-violation"
    | "unexpected-throw"
    | "suspended-on-402"
    | "operator-cancelled"
    | "deleted";

interface TaWorkflowInstruments {
    readonly terminalReason: Counter;
    readonly llmAttempts: Histogram;
}

let _instruments: TaWorkflowInstruments | undefined;
function getInstruments(): TaWorkflowInstruments {
    if (_instruments === undefined) {
        const meter = metrics.getMeter("cortex.harness.ta");
        _instruments = {
            terminalReason: meter.createCounter("cortex.harness.ta.workflow.terminal_reason", {
                description: "TA workflow terminal dispatches by reason (alert source)",
            }),
            llmAttempts: meter.createHistogram("cortex.harness.ta.llm.attempts", {
                description: "TA LLM step attempt count per call site",
            }),
        };
    }
    return _instruments;
}

/** Test hook — drop memoised instruments to rebind a fresh MeterProvider. */
export function __resetTaWorkflowMetricsForTest(): void {
    _instruments = undefined;
}

export function recordTerminalReason(reason: TaTerminalReason): void {
    getInstruments().terminalReason.add(1, { reason });
}

export function recordLlmAttempt(agentId: string, attempt: number): void {
    getInstruments().llmAttempts.record(attempt, { agent_id: agentId });
}
