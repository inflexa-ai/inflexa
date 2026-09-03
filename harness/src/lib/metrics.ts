/**
 * Custom OTel metrics for Cortex.
 *
 * Instruments:
 *   - cortex.artifact.reconcile.dropped — counter for missing manifest entries
 *   - cortex.artifact.reconcile.input_dropped — counter for lineage input drops
 *
 * Both carry `agent_id` (about 15 values) and never a per-step or per-run
 * identifier: a label with unbounded values multiplies the series count.
 *
 * Instruments are lazy so the record site binds to whichever `MeterProvider`
 * is globally registered at first use. The metrics API has no late-binding
 * proxy: a meter taken at module load, before `initOtel` runs, would stay
 * on the no-op provider for the life of the process.
 */

import { type Counter, metrics } from "@opentelemetry/api";

interface Instruments {
    readonly artifactReconcileDropped: Counter;
    readonly lineageInputDropped: Counter;
}

let instruments: Instruments | undefined;

function getInstruments(): Instruments {
    if (instruments === undefined) {
        const meter = metrics.getMeter("cortex");
        instruments = {
            artifactReconcileDropped: meter.createCounter("cortex.artifact.reconcile.dropped", {
                description:
                    "Manifest entries dropped because their on-disk file was missing at " +
                    "registration time (writes-then-deletes, renames). Tagged by agent_id.",
            }),
            lineageInputDropped: meter.createCounter("cortex.artifact.reconcile.input_dropped", {
                description:
                    "Tracked input reads dropped from lineage at reconcile because they are " +
                    "not content-attestable files of the analysis (directory reads, " +
                    "out-of-tree resolutions, paths absent at reconcile). Tagged by " +
                    "agent_id, reason.",
            }),
        };
    }
    return instruments;
}

/** Record one manifest entry dropped at reconcile. */
export function recordArtifactReconcileDropped(args: { readonly agentId: string }): void {
    getInstruments().artifactReconcileDropped.add(1, { agent_id: args.agentId });
}

export type LineageInputDropReason = "container-prefix" | "workspace-root" | "symlink-escape" | "missing" | "directory";

/** Record one tracked input read dropped from lineage at reconcile. */
export function recordLineageInputDropped(args: { readonly agentId: string; readonly reason: LineageInputDropReason }): void {
    getInstruments().lineageInputDropped.add(1, { agent_id: args.agentId, reason: args.reason });
}

/** Test hook — drop memoised instruments to rebind a fresh MeterProvider. */
export function __resetReconcileMetricsForTest(): void {
    instruments = undefined;
}
