/**
 * Transport-agnostic liveness escalation (the harness-sandbox-exec spec,
 * "sustained unavailability escalates to a liveness probe").
 *
 * The await loops observe the raw unreachability signal (consecutive
 * `unavailable` poll outcomes) but never adjudicate it themselves — poll
 * failures conflate "unreachable" with "unknown execId / non-200". The
 * backend inspect (`SandboxClient.isAlive`) is the sole arbiter of dead
 * versus live-but-slow, invoked through {@link probeLiveness} once
 * {@link createEscalationPolicy} arms.
 *
 * Shared with the watchdog: {@link syntheticFailureReason} and
 * {@link syntheticFailureResult} are the one constructor for synthetic
 * failures, so reasons and result shape are identical no matter which
 * adjudicator (in-loop escalation or watchdog) produced them.
 */

import type { ExecResult, SandboxLiveness, SandboxRef } from "./types.js";

/**
 * Consecutive `unavailable` polls tolerated before probing. On the fast poll
 * cadence (~1.5 s) this is seconds of silence before the first probe — a dead
 * container refuses connections instantly, so a spurious probe against a
 * healthy-but-quiet machine is rare, cheap (one backend inspect), and safe
 * (an `alive` verdict just resumes polling).
 */
export const PROBE_AFTER_UNAVAILABLE_POLLS = 4;

export type PollLivenessOutcome = "ok" | "unavailable";

export type ProbeVerdict =
    { readonly kind: "dead"; readonly oomKilled: boolean } | { readonly kind: "alive" } | { readonly kind: "inconclusive"; readonly detail: string };

/**
 * The consecutive-unavailable counter: `unavailable` increments, `ok` resets,
 * and crossing `threshold` arms one probe and re-arms from zero. Pure state
 * over checkpointed poll outcomes, so a replaying loop walks the identical
 * poll/probe sequence.
 */
export function createEscalationPolicy(threshold: number = PROBE_AFTER_UNAVAILABLE_POLLS): {
    /** Record a poll outcome; true means "run the probe now". */
    onPoll(outcome: PollLivenessOutcome): boolean;
} {
    let consecutiveUnavailable = 0;
    return {
        onPoll(outcome: PollLivenessOutcome): boolean {
            if (outcome === "ok") {
                consecutiveUnavailable = 0;
                return false;
            }
            consecutiveUnavailable += 1;
            if (consecutiveUnavailable < threshold) return false;
            consecutiveUnavailable = 0;
            return true;
        },
    };
}

/**
 * Run the backend inspect and collapse it to a three-valued verdict. Never
 * throws: `isAlive` throws on transient backend API errors by contract, but
 * inside an await loop a failed probe is not a failed exec — the same
 * discipline as a failed poll — so a throw maps to `inconclusive` and the
 * caller resumes polling.
 */
export async function probeLiveness(isAlive: (ref: SandboxRef) => Promise<SandboxLiveness>, ref: SandboxRef): Promise<ProbeVerdict> {
    let liveness: SandboxLiveness;
    try {
        liveness = await isAlive(ref);
    } catch (cause) {
        return { kind: "inconclusive", detail: cause instanceof Error ? cause.message : String(cause) };
    }
    return liveness.alive ? { kind: "alive" } : { kind: "dead", oomKilled: liveness.oomKilled };
}

/**
 * An OOM-killed machine gets a distinguishable reason so the step failure
 * reads "exceeded its memory limit", not a mystery death.
 */
export function syntheticFailureReason(liveness: Pick<SandboxLiveness, "oomKilled">): "sandbox-oom-killed" | "sandbox-dead" {
    return liveness.oomKilled ? "sandbox-oom-killed" : "sandbox-dead";
}

/** The synthetic-failure `ExecResult` for an exec whose machine died under it. */
export function syntheticFailureResult(execId: string, reason: string): ExecResult {
    return {
        execId,
        exitCode: null,
        stdout: "",
        stderr: "",
        durationMs: null,
        timedOut: false,
        syntheticFailure: { reason },
    };
}
