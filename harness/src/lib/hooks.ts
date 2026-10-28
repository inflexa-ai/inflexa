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

export type GateFailure = {
    readonly reason: string;
    /** True when the host asks the harness to suspend the work in place of a failure. */
    readonly suspend: boolean;
};

/**
 * The settlement a gate's `ResultAsync` resolves to, read structurally. An embedder whose neverthrow is
 * a second package copy resolves a settlement that holds the same members without the harness class,
 * and `passGate` reads it the same way.
 */
export type GateSettlement<T> = { isOk(): true; readonly value: T } | { isOk(): false; readonly error: GateFailure };

function settlementOk<T>(settled: GateSettlement<T>): settled is { isOk(): true; readonly value: T } {
    return settled.isOk();
}

/** A gate result that an embedder's own neverthrow copy produced: a thenable over the settlement. */
export type ForeignGateResult<T> = { then(onfulfilled: (settled: GateSettlement<T>) => unknown): unknown };

/** Await the gate result and read it as one settlement, whichever package copy produced it. */
async function settlementOf<T>(result: ResultAsync<T, GateFailure> | ForeignGateResult<T>): Promise<GateSettlement<T>> {
    if (result instanceof ResultAsync) {
        const settled = await result;
        return settled.isOk() ? { isOk: () => true, value: settled.value } : { isOk: () => false, error: settled.error };
    }
    return await result;
}

export type NoticeFailure = {
    readonly reason: string;
};

export type GateName =
    "RunAuthorizer.authorize" | "RunAuthorizer.renew" | "RunCharge.open" | "ArtifactRegistry.register" | "resolveRequestHeaders" | "resolveSandboxLabels";

export type NoticeName =
    | "RunAuthorizer.revoke"
    | "RunAuthorizer.revokeByMandateId"
    | "RunAuthorizer.suspend"
    | "RunCharge.close"
    | "ArtifactRegistry.sync"
    | "UsageRecorder.record"
    | "notifyDataProfileSettled";

export type GateRefusal =
    | { readonly kind: "failed"; readonly gate: GateName; readonly reason: string }
    | { readonly kind: "suspended"; readonly gate: GateName; readonly reason: string };

/**
 * The host can build its `Result` with its own copy of neverthrow. The helper
 * gives the outcome again as a `Result` of the copy of the harness. Thus the
 * checkpoint recipes (`runtime/result-serialization.ts`) recognize the class,
 * and a replay reads the same outcome.
 */
export function passGate<T>(gate: GateName, result: ResultAsync<T, GateFailure> | ForeignGateResult<T>): ResultAsync<T, GateRefusal> {
    return new ResultAsync(
        (async () => {
            const settled = await settlementOf(result);
            if (settlementOk(settled)) return ok(settled.value);
            return err<T, GateRefusal>({ kind: settled.error.suspend ? "suspended" : "failed", gate, reason: settled.error.reason });
        })(),
    );
}

export async function deliverNotice(log: Logger, notice: NoticeName, result: ResultAsync<void, NoticeFailure>): Promise<boolean> {
    const delivered = await result;
    if (delivered.isOk()) return true;
    log.error("a notice of the host failed", { notice, reason: delivered.error.reason });
    return false;
}
