/**
 * Step-summary OTel metrics — Middleware.io routing follows the global
 * meter provider (see `harness/lib/otel.ts`).
 *
 * cortex.summary.null_count — counter, incremented when a step-summary
 *   turn returns empty markdown or its provider call throws. Tagged with
 *   `agent_id` and a `reason` discriminator (`"empty" | "throw"`) so
 *   weekly review can split mode of failure.
 */

import { type Counter, metrics } from "@opentelemetry/api";

let counter: Counter | undefined;

function getCounter(): Counter {
    if (counter === undefined) {
        counter = metrics.getMeter("cortex.harness.execution").createCounter("cortex.summary.null_count", {
            description: "Step-summary turns that returned empty markdown or threw.",
        });
    }
    return counter;
}

export function incrementSummaryNullCount(agentId: string, reason: "empty" | "throw"): void {
    getCounter().add(1, { agent_id: agentId, reason });
}
