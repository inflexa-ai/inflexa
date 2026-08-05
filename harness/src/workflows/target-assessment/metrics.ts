/**
 * OpenTelemetry counters for the target-assessment DBOS workflow.
 *
 * Surfaces two signals:
 *  - `cortex.harness.ta.workflow.terminal_reason` — per terminal path; the
 *    alert in §16.5/§16.6 reads this. `reason` ∈ {completed,
 *    target-unresolved, schema-violation, derived-invariant-violation,
 *    unexpected-throw, suspended-on-402, operator-cancelled}.
 *  - billing cache_hit/_miss live in `harness/billing/target-assessment-resolver.ts`.
 *
 * Memoised meter so a re-imported module in tests doesn't recreate the
 * instruments against the same MeterProvider (which would log noisy
 * "duplicate instrument" warnings).
 */

import { metrics, type Counter } from "@opentelemetry/api";

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
}

let _instruments: TaWorkflowInstruments | undefined;
function getInstruments(): TaWorkflowInstruments {
    if (_instruments === undefined) {
        const meter = metrics.getMeter("cortex.harness.ta");
        _instruments = {
            terminalReason: meter.createCounter("cortex.harness.ta.workflow.terminal_reason", {
                description: "TA workflow terminal dispatches by reason (alert source)",
            }),
        };
    }
    return _instruments;
}

export function recordTerminalReason(reason: TaTerminalReason): void {
    getInstruments().terminalReason.add(1, { reason });
}
