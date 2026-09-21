/**
 * The two kinds of host hook: a gate and a notice.
 *
 * A gate gives a value or a permission that the harness must have before it
 * can continue an operation. A notice reports a fact after the operation. The
 * type of each hook shows its kind:
 *
 *   gate:   (input) => ResultAsync<T, GateFailure>
 *   notice: (input) => ResultAsync<void, NoticeFailure>
 *
 * The harness calls each hook through `passGate` or `deliverNotice`, thus no
 * call site selects its own failure policy, and no call site puts a `try` or a
 * `catch` around a hook. A hook gives a failure as an `err`. A hook whose
 * promise rejects has a defect, and the rejection passes through the helpers
 * with no change.
 *
 * The reason of a failure is the text of the host. The harness carries it and
 * never reads it. The flag `suspend` is part of the contract, thus the harness
 * branches on it.
 */

import type { ResultAsync } from "neverthrow";

import type { Logger } from "./logger.js";

/** The failure of a gate. */
export interface GateFailure {
    readonly reason: string;
    /** True when the host asks the harness to suspend the work in place of a failure. */
    readonly suspend: boolean;
}

/** The failure of a notice. */
export interface NoticeFailure {
    readonly reason: string;
}

/** Each gate of the harness, by the name that a refusal and a log record carry. */
export type GateName = "RunAuthorizer.authorize" | "RunCharge.open" | "ArtifactRegistry.register" | "resolveRequestHeaders" | "resolveSandboxLabels";

/** Each notice of the harness, by the name that a log record carries. */
export type NoticeName = "RunAuthorizer.revoke" | "RunAuthorizer.revokeByJti" | "RunCharge.close" | "ArtifactRegistry.sync" | "UsageRecorder.record";

/**
 * A gate that refused, as the operation sees it. The flag `suspend` of the
 * host selects the kind: the operation suspends in place of a failure.
 */
export type GateRefusal =
    | { readonly kind: "failed"; readonly gate: GateName; readonly reason: string }
    | { readonly kind: "suspended"; readonly gate: GateName; readonly reason: string };

/**
 * Pass a gate. An `ok` is the value that the operation continues with, as the
 * host gives it. An `err` becomes the refusal that the operation ends on.
 */
export function passGate<T>(gate: GateName, result: ResultAsync<T, GateFailure>): ResultAsync<T, GateRefusal> {
    return result.mapErr((failure): GateRefusal => ({ kind: failure.suspend ? "suspended" : "failed", gate, reason: failure.reason }));
}

/**
 * Deliver a notice. The work is complete, thus an `err` does not change the
 * outcome of the operation: the helper logs the reason at the error level.
 * Resolves `true` when the notice succeeded, for a caller that reports it.
 */
export async function deliverNotice(log: Logger, notice: NoticeName, result: ResultAsync<void, NoticeFailure>): Promise<boolean> {
    const delivered = await result;
    if (delivered.isOk()) return true;
    log.error("a notice of the host failed", { notice, reason: delivered.error.reason });
    return false;
}
