/**
 * Custom OTel metrics for Cortex.
 *
 * Instruments:
 *   - cortex.artifact.reconcile.dropped — counter for missing manifest entries
 */

import { metrics } from "@opentelemetry/api";

const meter = metrics.getMeter("cortex");

export const artifactReconcileDropped = meter.createCounter("cortex.artifact.reconcile.dropped", {
    description:
        "Manifest entries dropped because their on-disk file was missing at " +
        "registration time (writes-then-deletes, renames). Tagged by agent_id, step_id.",
});
