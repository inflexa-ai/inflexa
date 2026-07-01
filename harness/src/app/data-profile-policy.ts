/**
 * Data-profile policy — the pure decision an embedder applies when it reads a
 * data-profile status (see CONTEXT.md "Application service layer"). It decides
 * whether to (re)trigger profiling; the embedder executes the staging + trigger
 * — staging stays embedder-side per the data-profile-init spec, and the atomic running→expired
 * flip stays an SQL guard (`expireStaleDataProfile`), not part of this decision.
 */

export type DataProfileLifecycleStatus = "pending" | "running" | "completed" | "failed";

/**
 * A completed profile is stale when the analysis's seed input set no longer
 * matches the set the profile actually covered — a file was added or swapped
 * since profiling. An empty seed set is never stale (nothing to compare).
 */
export function isDataProfileStale(seedInputFileIds: readonly string[], profiledInputFileIds: readonly string[]): boolean {
    if (seedInputFileIds.length === 0) return false;
    if (seedInputFileIds.length !== profiledInputFileIds.length) return true;
    const profiled = new Set(profiledInputFileIds);
    return seedInputFileIds.some((id) => !profiled.has(id));
}

export type DataProfileAction = { readonly kind: "none" } | { readonly kind: "trigger" } | { readonly kind: "retrigger" };

export interface DataProfileDecisionInput {
    readonly status: DataProfileLifecycleStatus;
    readonly seedInputFileIds: readonly string[];
    readonly profiledInputFileIds: readonly string[];
}

/**
 * Decide the next profiling action from a (post-expire) status:
 *   - `pending`            → `trigger`   (first profile)
 *   - `completed` && stale → `retrigger` (inputs changed since profiling)
 *   - anything else        → `none`
 *
 * `running` is left to finish (or to the SQL expiry guard); `failed` is retried
 * explicitly via the retry route, never implicitly on read.
 */
export function decideDataProfileAction(input: DataProfileDecisionInput): DataProfileAction {
    if (input.status === "pending") return { kind: "trigger" };
    if (input.status === "completed" && isDataProfileStale(input.seedInputFileIds, input.profiledInputFileIds)) {
        return { kind: "retrigger" };
    }
    return { kind: "none" };
}
