/**
 * The suspension of work (workflow-suspension spec).
 *
 * A suspension starts only from a model request that fails with a `suspend`
 * error, or from a gate that refuses with the suspend flag. The harness carries
 * the reason of the host as it is and never reads it: no path compares a
 * reason to a value, and no path reads the text of an error message.
 *
 * The owner of the result of a workflow selects the mechanism. A durable owner
 * (`executeAnalysis`, `sandbox-step`, `data-profile`) records the reason in its
 * stored state and ends in the DBOS state `CANCELLED`, which `resumeWorkflow`
 * reads. A workflow with a live caller (`derive-table-exec`, `extract-values`)
 * returns the suspension as the `err` of its result. Each suspension of a
 * workflow marks the analysis through `suspendAnalysis` (`state/analyses.ts`).
 */

import { DBOS } from "@dbos-inc/dbos-sdk";

import type { GateRefusal } from "../lib/hooks.js";
import { findSuspendError } from "../providers/errors.js";
import type { SuspendingRefusal } from "../sandbox/sandbox-error.js";

/** A suspension, with the reason of the host. Plain data, thus it crosses a DBOS checkpoint as it is. */
export interface Suspension {
    readonly kind: "suspended";
    readonly reason: string;
}

/** The suspension of a failure that carries a `suspend` provider error on its cause chain. */
export function suspensionOfFailure(err: unknown): Suspension | undefined {
    const found = findSuspendError(err);
    return found === undefined ? undefined : { kind: "suspended", reason: found.reason };
}

/** The suspension of a gate refusal with the suspend flag. A refusal without the flag fails the operation. */
export function suspensionOfRefusal(refusal: GateRefusal): Suspension | undefined {
    return refusal.kind === "suspended" ? { kind: "suspended", reason: refusal.reason } : undefined;
}

/** The suspension of a spawn that the label hook refused with the suspend flag. */
export function suspensionOfSpawnRefusal(refusal: SuspendingRefusal): Suspension {
    return { kind: "suspended", reason: refusal.reason };
}

/**
 * End the calling workflow in the DBOS state `CANCELLED`. The cancel lands at
 * the next DBOS operation, thus the named step raises
 * `DBOSWorkflowCancelledError` and nothing after it runs.
 */
export async function cancelSelf(stepName: string): Promise<never> {
    await DBOS.cancelWorkflow(DBOS.workflowID!);
    await DBOS.runStep(async () => undefined, { name: stepName });
    throw new Error(`unreachable: ${stepName} did not raise the cancellation`);
}
