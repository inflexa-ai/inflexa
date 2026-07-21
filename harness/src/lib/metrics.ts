/**
 * Custom OTel metrics for Cortex.
 *
 * Instruments:
 *   - cortex.artifact.reconcile.dropped — counter for missing manifest entries
 *   - cortex.artifact.reconcile.input_dropped — counter for lineage input drops
 *   - cortex.lineage.edge_rejected — counter for lineage edges refused at classification
 *
 * Instruments are created on first record, never at module load. `metrics.getMeter`
 * resolves the global `MeterProvider` at creation time and the metrics API has no
 * proxy that upgrades a meter afterwards (the trace API's `ProxyTracer` has no
 * counterpart here), so an instrument built before a provider is registered stays
 * bound to the noop meter for the life of the process and reaches no exporter.
 * This module sits in `index.ts`'s static import graph, which is evaluated before
 * an embedder's entry point runs a line — so import time is exactly the moment no
 * provider is registered yet.
 */

import { type Counter, metrics } from "@opentelemetry/api";

/** Why a tracked input ref was removed from lineage at reconcile. */
export type LineageInputDropReason = "directory" | "container-prefix" | "workspace-root";

/** Why an exec read was refused a lineage edge at classification. */
export type LineageEdgeRejectionReason = "producing-step-not-completed" | "snapshot-unavailable";

interface Instruments {
    readonly artifactReconcileDropped: Counter;
    readonly lineageInputDropped: Counter;
    readonly lineageEdgeRejected: Counter;
}

let instruments: Instruments | undefined;

function getInstruments(): Instruments {
    if (instruments === undefined) {
        const meter = metrics.getMeter("cortex");
        instruments = {
            artifactReconcileDropped: meter.createCounter("cortex.artifact.reconcile.dropped", {
                description:
                    "Manifest entries dropped because their on-disk file was missing at " +
                    "registration time (writes-then-deletes, renames). Tagged by agent_id, step_id.",
            }),
            lineageInputDropped: meter.createCounter("cortex.artifact.reconcile.input_dropped", {
                description:
                    "Tracked input reads dropped from lineage at reconcile because they are " +
                    "not content-attestable files of the analysis (directory reads, " +
                    "out-of-tree resolutions). Tagged by agent_id, step_id, reason.",
            }),
            lineageEdgeRejected: meter.createCounter("cortex.lineage.edge_rejected", {
                description:
                    "Exec reads refused at classification because the producing step was not " +
                    "observed `completed` when the exec was submitted, so no lineage edge was " +
                    "created for them. Tagged by agent_id, step_id, reason " +
                    "(producing-step-not-completed | snapshot-unavailable).",
            }),
        };
    }
    return instruments;
}

/** Record one manifest entry reconcile dropped for want of a file on disk. */
export function recordArtifactReconcileDropped(args: { readonly agentId: string; readonly stepId: string }): void {
    getInstruments().artifactReconcileDropped.add(1, { agent_id: args.agentId, step_id: args.stepId });
}

/** Record one input ref reconcile removed from a lineage the collector already held. */
export function recordLineageInputDropped(args: { readonly agentId: string; readonly stepId: string; readonly reason: LineageInputDropReason }): void {
    getInstruments().lineageInputDropped.add(1, { agent_id: args.agentId, step_id: args.stepId, reason: args.reason });
}

/**
 * Record one edge never asserted, where `recordLineageInputDropped` records a ref
 * removed from a lineage the collector already held. The two fire at different
 * sites for different causes, so folding them together would make either counter —
 * and any dashboard over it — misreport where the loss happened.
 *
 * `agentId` is left out of the tags rather than filled with a placeholder when the
 * caller does not know it — an invented dimension value is indistinguishable from a
 * real agent in an aggregation.
 */
export function recordLineageEdgeRejected(args: { readonly agentId?: string; readonly stepId: string; readonly reason: LineageEdgeRejectionReason }): void {
    getInstruments().lineageEdgeRejected.add(1, {
        ...(args.agentId === undefined ? {} : { agent_id: args.agentId }),
        step_id: args.stepId,
        reason: args.reason,
    });
}

/**
 * Drop the memoized instruments so the next record rebinds to a freshly-registered
 * `MeterProvider`. Test-only — production registers its provider once at startup.
 */
export function __resetLineageMetricsForTest(): void {
    instruments = undefined;
}
