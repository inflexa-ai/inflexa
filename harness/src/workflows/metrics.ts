/**
 * Workflow-side OTel metrics.
 *
 *   - cortex.workflow.parent.cancelled_children — counter, incremented once
 *     per child the fail-fast or pause cascade reaps. A baseline near 0
 *     means runs land cleanly; a spike means siblings keep colliding with
 *     a single failing step.
 *
 * Instruments are lazy so the workflow body binds to whichever
 * `MeterProvider` is globally registered at startup.
 */

import { type Counter, metrics } from "@opentelemetry/api";

interface Instruments {
    readonly cancelledChildren: Counter;
}

let instruments: Instruments | undefined;

function getInstruments(): Instruments {
    if (instruments === undefined) {
        const meter = metrics.getMeter("cortex.workflow");
        instruments = {
            cancelledChildren: meter.createCounter("cortex.workflow.parent.cancelled_children", {
                description: "Children cancelled by the parent's fail-fast or pause cascade",
            }),
        };
    }
    return instruments;
}

/**
 * Record one child cancellation. The parent calls this once per
 * `DBOS.cancelWorkflow(childWorkflowId)` in the cascade (fail-fast OR
 * pause). `cause` distinguishes the two so dashboards can split the
 * counter.
 */
export function recordCancelledChild(args: { readonly cause: "fail_fast" | "budget_exceeded" | "external_cancel" }): void {
    getInstruments().cancelledChildren.add(1, { cause: args.cause });
}

/** Test hook — drop memoised instruments to rebind a fresh MeterProvider. */
export function __resetWorkflowMetricsForTest(): void {
    instruments = undefined;
}
