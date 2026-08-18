/**
 * Data-profile policy — the pure decision an embedder applies when it reads a
 * data-profile status (see CONTEXT.md "Application service layer"). It decides
 * whether to (re)trigger profiling; the embedder executes the staging + trigger
 * — staging stays embedder-side per the data-profile-init spec, and the atomic running→expired
 * flip stays an SQL guard (`expireStaleDataProfile`), not part of this decision.
 */

import type { DataProfileInputSignature, DataProfileLifecycleStatus } from "../contracts/data-profile.js";

export type { DataProfileLifecycleStatus };

/**
 * The analysis's inputs as they are NOW. A caller holding sizes and mtimes supplies
 * the signature; one holding only the ledger's seeded ids supplies just those, and the
 * comparison degrades honestly to what those ids can settle.
 */
export interface CurrentInputSet {
    readonly fileIds: readonly string[];
    readonly signature?: DataProfileInputSignature;
}

/** The comparand a profile snapshot carries. Which one is present depends on its era. */
export interface ProfiledInputSnapshot {
    readonly inputSignature?: DataProfileInputSignature;
    readonly inputFileIds?: readonly string[];
}

/**
 * A completed profile is stale when the analysis's current input set no longer matches
 * the set the profile actually covered.
 *
 * The signature is preferred where both sides carry one: it covers size and mtime as
 * well as identity, so an in-place edit is drift too. A snapshot predating the
 * signature falls back to its identity list rather than being treated as drift, since
 * that list answers the same question for the set it covered. A snapshot carrying
 * NEITHER is drift: nothing establishes what it covered, and one re-profile heals it —
 * exactly how a wholly absent `result` is already treated.
 *
 * An empty current set is never stale: there is nothing to compare, and an analysis
 * whose inputs were removed is handled by clearing the profile, not by re-profiling it.
 */
export function isDataProfileStale(current: CurrentInputSet, profiled: ProfiledInputSnapshot | null | undefined): boolean {
    if (current.fileIds.length === 0 && current.signature === undefined) return false;
    if (!profiled) return true;

    if (profiled.inputSignature) {
        // A caller with no signature of its own can still compare counts, which catches
        // an added or removed file. It cannot catch a same-count swap, and claiming
        // otherwise would be a verdict the comparand does not support.
        if (!current.signature) return profiled.inputSignature.count !== current.fileIds.length;
        return profiled.inputSignature.digest !== current.signature.digest || profiled.inputSignature.count !== current.signature.count;
    }

    if (profiled.inputFileIds) {
        if (current.fileIds.length !== profiled.inputFileIds.length) return true;
        const covered = new Set(profiled.inputFileIds);
        return current.fileIds.some((id) => !covered.has(id));
    }

    return true;
}

export type DataProfileAction = { readonly kind: "none" } | { readonly kind: "trigger" } | { readonly kind: "retrigger" };

export interface DataProfileDecisionInput {
    readonly status: DataProfileLifecycleStatus;
    /** The analysis's inputs as they are now — the seeded ids, plus a signature where the caller has one. */
    readonly current: CurrentInputSet;
    /** The comparand the stored profile carries, or null when it holds none. */
    readonly profiled: ProfiledInputSnapshot | null;
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
    if (input.status === "completed" && isDataProfileStale(input.current, input.profiled)) {
        return { kind: "retrigger" };
    }
    return { kind: "none" };
}
