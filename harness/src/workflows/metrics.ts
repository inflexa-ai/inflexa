/**
 * Workflow-side OTel metrics → Middleware.io.
 *
 * Two signals so 3-hour runs and pause-resume cascades are observable:
 *   - cortex.workflow.parent.cancelled_children — counter, incremented once
 *     per child the fail-fast or pause cascade reaps. A baseline near 0
 *     means runs land cleanly; a spike means siblings keep colliding with
 *     a single failing step.
 *   - cortex.workflow.stream.bytes               — counter, incremented by
 *     the byte count of every UI part written onto the DBOS stream. The
 *     leading indicator for 3-hour stream growth is monotonic — a runaway
 *     emitter shows up as an unbounded slope.
 *
 * Instruments are lazy so the workflow body binds to whichever
 * `MeterProvider` is globally registered at startup.
 */

import { type Counter, metrics } from "@opentelemetry/api";

interface Instruments {
    readonly cancelledChildren: Counter;
    readonly streamBytes: Counter;
}

let instruments: Instruments | undefined;

function getInstruments(): Instruments {
    if (instruments === undefined) {
        const meter = metrics.getMeter("cortex.workflow");
        instruments = {
            cancelledChildren: meter.createCounter("cortex.workflow.parent.cancelled_children", {
                description: "Children cancelled by the parent's fail-fast or pause cascade",
            }),
            streamBytes: meter.createCounter("cortex.workflow.stream.bytes", {
                description: "Bytes written to the parent's DBOS UI-parts stream — proxy for " + "3-hour stream growth",
                unit: "By",
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

/**
 * Record one UI-part write. `bytes` is the serialised JSON size of the
 * part as it lands on the stream; `kind` is the part `type` for
 * dashboarding. The workflow body wraps its `DBOS.writeStream` call site
 * so a single emitter records once per part.
 */
export function recordStreamWrite(args: { readonly bytes: number; readonly kind: string }): void {
    getInstruments().streamBytes.add(args.bytes, { kind: args.kind });
}

/** Test hook — drop memoised instruments to rebind a fresh MeterProvider. */
export function __resetWorkflowMetricsForTest(): void {
    instruments = undefined;
}
