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
 * reads. A pass inside a tool call (the derivation and the extraction of a
 * report session) returns the suspension as the `err` of its result. A
 * suspension of an analysis run or of a data profile marks the analysis through
 * `suspendAnalysis` (`state/analyses.ts`). A pass inside a tool call does not
 * mark it: the agent reads the suspension as a tool result.
 */

import { DBOS } from "@dbos-inc/dbos-sdk";

import type { GateRefusal } from "../lib/hooks.js";
import { modelFailureOf } from "../providers/errors.js";
import type { SuspendingRefusal } from "../sandbox/sandbox-error.js";

/** Plain data, thus it crosses a DBOS checkpoint as it is. */
export type Suspension = {
    readonly kind: "suspended";
    readonly reason: string;
};

export function suspensionOfFailure(err: unknown): Suspension | undefined {
    const failure = modelFailureOf(err);
    return failure.kind === "billing" ? { kind: "suspended", reason: failure.reason } : undefined;
}

export function suspensionOfRefusal(refusal: GateRefusal): Suspension | undefined {
    return refusal.kind === "suspended" ? { kind: "suspended", reason: refusal.reason } : undefined;
}

export function suspensionOfSpawnRefusal(refusal: SuspendingRefusal): Suspension {
    return { kind: "suspended", reason: refusal.reason };
}

/**
 * The cancel lands at the next DBOS operation, thus the named step raises
 * `DBOSWorkflowCancelledError` and nothing after it runs.
 */
export async function cancelSelf(stepName: string): Promise<never> {
    // A workflow id exists only inside a workflow, and without one there is no workflow to cancel.
    const workflowId = DBOS.workflowID;
    if (workflowId === undefined) {
        throw new Error(`cancelSelf("${stepName}") ran outside a workflow, thus there is no workflow to cancel`);
    }
    await DBOS.cancelWorkflow(workflowId);
    await DBOS.runStep(() => Promise.resolve(undefined), { name: stepName });
    throw new Error(`unreachable: ${stepName} did not raise the cancellation`);
}
