/**
 * Correction loop for Phase-3 fan-out branches that returned empty
 * without an error.
 *
 * Contract:
 *   1. If `coverage` is `available` (non-empty data), pass through.
 *   2. If `coverage` is `queried_no_data` and we have a deterministic
 *      alt-name retry available, run ONE retry. If it succeeds, return
 *      the new payload tagged `available`.
 *   3. If still empty after the alt-name retry, escalate ONCE to the
 *      responsible Phase-2 agent (via the supplied `escalate` callback)
 *      with the failure bundle. If the agent returns a usable payload,
 *      return it. Otherwise return `coverage: "queried_no_data"`.
 *
 * The escalation callback is optional — callers without an agent fall
 * back to a final coverage tag without escalation.
 */

import type { Coverage, SerializedError } from "./coverage.js";

type CoverageEnvelope<T> =
    | { coverage: "available"; data: T }
    | { coverage: "queried_no_data"; error?: SerializedError }
    | { coverage: "not_loaded"; reason?: string };

export interface CorrectionInput<T> {
    initial: CoverageEnvelope<T>;
    altRetry?: () => Promise<CoverageEnvelope<T>>;
    escalate?: () => Promise<CoverageEnvelope<T>>;
}

export interface CorrectionTrace {
    altRetryAttempted: boolean;
    altRetrySucceeded: boolean;
    escalationAttempted: boolean;
    escalationSucceeded: boolean;
    finalCoverage: Coverage;
}

export async function runCorrectionLoop<T>(input: CorrectionInput<T>): Promise<{ result: CoverageEnvelope<T>; trace: CorrectionTrace }> {
    const trace: CorrectionTrace = {
        altRetryAttempted: false,
        altRetrySucceeded: false,
        escalationAttempted: false,
        escalationSucceeded: false,
        finalCoverage: input.initial.coverage,
    };

    if (input.initial.coverage === "available") {
        return { result: input.initial, trace };
    }
    if (input.initial.coverage === "not_loaded") {
        return { result: input.initial, trace };
    }

    if (input.altRetry) {
        trace.altRetryAttempted = true;
        try {
            const retried = await input.altRetry();
            if (retried.coverage === "available") {
                trace.altRetrySucceeded = true;
                trace.finalCoverage = "available";
                return { result: retried, trace };
            }
        } catch {
            // alt retry failed; proceed to escalation
        }
    }

    if (input.escalate) {
        trace.escalationAttempted = true;
        try {
            const esc = await input.escalate();
            if (esc.coverage === "available") {
                trace.escalationSucceeded = true;
                trace.finalCoverage = "available";
                return { result: esc, trace };
            }
        } catch {
            // escalation failed; fall through
        }
    }

    trace.finalCoverage = "queried_no_data";
    return { result: input.initial, trace };
}
