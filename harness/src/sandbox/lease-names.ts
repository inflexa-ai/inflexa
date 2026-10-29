/** The names that the lease module, the reconciler, and the purge share. */

import { createHash } from "node:crypto";

import { HARNESS_PRIVATE_DIR } from "../workspace/paths.js";

/** The prefix of each lease workflow id. A purge finds the lease workflows of an analysis by it. */
export const LEASE_WORKFLOW_PREFIX = "sandboxlease";

export function leaseWorkflowIdOf(analysisId: string, leaseKey: string, generation: number): string {
    return `${LEASE_WORKFLOW_PREFIX}:${analysisId}:${leaseKey}:${generation}`;
}

/** The workspace-relative records directory of a lease key. Each generation of the key uses it. */
export function leaseRecordTail(leaseKey: string): string {
    return `${HARNESS_PRIVATE_DIR}/exec-records/${createHash("sha256").update(leaseKey, "utf8").digest("hex").slice(0, 16)}`;
}
