/**
 * WorkflowPurger — the durability-engine seam for reclaiming workflow rows.
 *
 * Most of what an analysis stores lives in the durability engine's own ledger —
 * sandbox-agent step outputs, the run-event streams, workflow inputs — not in the
 * harness's `cortex_*` tables, so removing an analysis has to reach that ledger.
 * The engine is quarantined out of the state layer, the tools, and the loop
 * (`RunLauncher` holds that line for the launch direction); this seam is the
 * reclaim direction of the same quarantine. It speaks only in workflow ids, so a
 * caller never names an engine type.
 *
 * Cancellation is a separate verb from deletion, and a caller uses it first:
 * deleting the status row of a running workflow does not stop the executor
 * running it, and that executor goes on writing rows behind the delete. A caller
 * that cannot cancel must not proceed to a delete whose completeness it can no
 * longer claim.
 *
 * Absence is a normal outcome throughout. A host may purge from a process that
 * never launched the durable runtime, and the engine creates its schema at first
 * launch — so a missing ledger means "nothing to purge", not a failure. Unknown
 * ids are likewise ignored rather than rejected, which is what makes a re-run of
 * an already-reclaimed purge succeed.
 */

import type { ResultAsync } from "neverthrow";

import type { DbError } from "../lib/db-result.js";

export interface WorkflowPurger {
    /** Workflow ids in a given id namespace (e.g. `dataprofile:{analysisId}:`). Empty when the ledger has no schema yet. */
    findByIdPrefix(prefix: string): ResultAsync<string[], DbError>;
    /** Cancel the given workflows so no executor keeps writing behind a purge. Unknown ids are ignored. */
    cancel(workflowIds: readonly string[]): ResultAsync<void, DbError>;
    /**
     * Delete the given workflows, and their descendants when `includeDescendants`.
     * Resolves to how many workflows the delete targeted, counted immediately before
     * it — a post-fact tally is not available, because the engine owns the delete and
     * reports no count of its own.
     */
    deleteWorkflows(workflowIds: readonly string[], includeDescendants?: boolean): ResultAsync<number, DbError>;
}
