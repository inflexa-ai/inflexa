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

import { err, ok, ResultAsync } from "neverthrow";

import type { Logger } from "./logger.js";

export interface GateFailure {
    readonly reason: string;
    /** True when the host asks the harness to suspend the work in place of a failure. */
    readonly suspend: boolean;
}

export interface NoticeFailure {
    readonly reason: string;
}

export type GateName = "RunAuthorizer.authorize" | "RunCharge.open" | "ArtifactRegistry.register" | "resolveRequestHeaders" | "resolveSandboxLabels";

export type NoticeName = "RunAuthorizer.revoke" | "RunAuthorizer.revokeByJti" | "RunCharge.close" | "ArtifactRegistry.sync" | "UsageRecorder.record";

export type GateRefusal =
    | { readonly kind: "failed"; readonly gate: GateName; readonly reason: string }
    | { readonly kind: "suspended"; readonly gate: GateName; readonly reason: string };

/**
 * The host can build its `Result` with its own copy of neverthrow. The helper
 * gives the outcome again as a `Result` of the copy of the harness. Thus the
 * checkpoint recipes (`runtime/result-serialization.ts`) recognize the class,
 * and a replay reads the same outcome.
 */
export function passGate<T>(gate: GateName, result: ResultAsync<T, GateFailure>): ResultAsync<T, GateRefusal> {
    return new ResultAsync(
        Promise.resolve(result).then((settled) =>
            settled.isOk()
                ? ok(settled.value)
                : err<T, GateRefusal>({ kind: settled.error.suspend ? "suspended" : "failed", gate, reason: settled.error.reason }),
        ),
    );
}

export async function deliverNotice(log: Logger, notice: NoticeName, result: ResultAsync<void, NoticeFailure>): Promise<boolean> {
    const delivered = await result;
    if (delivered.isOk()) return true;
    log.error("a notice of the host failed", { notice, reason: delivered.error.reason });
    return false;
}
