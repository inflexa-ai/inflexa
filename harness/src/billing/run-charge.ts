/**
 * `RunCharge` — the run-level billing-bracket seam.
 *
 * `executeAnalysis` opens a running charge at init and closes it on the
 * terminal path with one of four reasons. A managed embedder wires an
 * external running-charge bracket; OSS wires a no-op. The harness only ever sees this
 * interface — the body brackets the run, the embedder owns the ledger.
 */

import type { AgentSession } from "../auth/types.js";

export interface RunCharge {
    /** Open the run's running charge at init. */
    open(args: { analysisId: string; runId: string; session: AgentSession }): Promise<void>;

    /** Close the run's running charge with one of four terminal reasons. */
    close(args: { analysisId: string; runId: string; reason: "ok" | "error" | "canceled" | "budget_exceeded"; session: AgentSession }): Promise<void>;
}
