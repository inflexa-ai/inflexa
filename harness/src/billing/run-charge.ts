/**
 * `RunCharge` — the run-level billing-bracket seam.
 *
 * `executeAnalysis` opens a running charge at init and closes it on the
 * terminal path with the outcome of the run. A managed embedder wires an
 * external running-charge bracket; OSS wires a no-op. The harness only ever sees this
 * interface — the body brackets the run, the embedder owns the ledger.
 *
 * `open` is a gate: an `err` ends the run before a step starts, or suspends it
 * when the host asks. `close` is a notice: an `err` is logged, and the terminal
 * status of the run does not change (see `lib/hooks.ts`).
 */

import type { ResultAsync } from "neverthrow";

import type { AgentSession } from "../auth/types.js";
import type { GateFailure, NoticeFailure } from "../lib/hooks.js";

/**
 * The outcome of a run, as `close` gets it. A suspension carries the reason of
 * the host, which the harness does not read.
 */
export type RunChargeOutcome = { readonly kind: "ok" | "error" | "canceled" } | { readonly kind: "suspended"; readonly reason: string };

export interface RunCharge {
    /** Open the run's running charge at init. */
    open(args: { analysisId: string; runId: string; session: AgentSession }): ResultAsync<void, GateFailure>;

    /** Close the run's running charge with the outcome of the run. */
    close(args: { analysisId: string; runId: string; outcome: RunChargeOutcome; session: AgentSession }): ResultAsync<void, NoticeFailure>;
}
