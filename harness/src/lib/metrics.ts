/**
 * Custom OTel metrics for Cortex.
 *
 * Instruments:
 *   - cortex.artifact.reconcile.dropped — counter for missing manifest entries
 *   - cortex.artifact.reconcile.input_dropped — counter for lineage input drops
 */

import { metrics } from "@opentelemetry/api";

const meter = metrics.getMeter("cortex");

export const artifactReconcileDropped = meter.createCounter("cortex.artifact.reconcile.dropped", {
    description:
        "Manifest entries dropped because their on-disk file was missing at " +
        "registration time (writes-then-deletes, renames). Tagged by agent_id, step_id.",
});

export const lineageInputDropped = meter.createCounter("cortex.artifact.reconcile.input_dropped", {
    description:
        "Tracked input reads dropped from lineage at reconcile because they are " +
        "not content-attestable files of the analysis (directory reads, " +
        "out-of-tree resolutions). Tagged by agent_id, step_id, reason.",
});
