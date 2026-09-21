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
                description: "Children cancelled by the parent's fail-fast or suspension cascade",
            }),
        };
    }
    return instruments;
}

/**
 * Record one child cancellation. The parent calls this once per
 * `DBOS.cancelWorkflow(childWorkflowId)` in the cascade (fail-fast OR
 * suspension). `cause` is `fail_fast`, `external_cancel`, or the reason of
 * the host for a suspension, carried unread, so dashboards can split the
 * counter by the reason that the host gave.
 */
export function recordCancelledChild(args: { readonly cause: string }): void {
    getInstruments().cancelledChildren.add(1, { cause: args.cause });
}

/** Test hook — drop memoised instruments to rebind a fresh MeterProvider. */
export function __resetWorkflowMetricsForTest(): void {
    instruments = undefined;
}
