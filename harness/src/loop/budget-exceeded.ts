/**
 * HTTP 402 `budget_exceeded` classifier.
 *
 * Detects when an LLM call failed because the billing gateway reported the
 * caller's budget was exhausted. This is NOT a transient error — retrying
 * is wasteful because every subsequent call charged to the same budget will
 * also fail until the user tops up.
 *
 * Classification order (first hit wins), and the order is load-bearing:
 *   1. Structured `statusCode === 402` (or `status === 402`) on any
 *      link of the cause chain. The gateway emits 402 exclusively for
 *      `budget_exceeded`, so a structured 402 is unambiguous.
 *   2. A `ProviderError` on the value or its cause chain that was decided on
 *      a status: its `type` answers, and the text patterns are skipped.
 *   3. Pattern fallback: `/budget.?exceeded/i` on the stringified
 *      top-level error message. Covers stringified throws and paths
 *      where no `statusCode` is attached (ops scripts, sandbox-server
 *      surfacing upstream billing errors as text).
 *
 * Step 2 exists because the text heuristic must never outrank a real
 * classification. A `ProviderError` message carries an excerpt of the provider's
 * response body, so a non-retryable 400 whose body merely mentions a budget would
 * otherwise match step 3 — and the callers of this predicate act on it fatally
 * (`sandbox-step` self-cancels the workflow, `execute-analysis` re-raises it as a
 * budget throw). A phrase inside a quoted body is not evidence against the status
 * the failure actually carried.
 *
 * "Decided on a status" is the load-bearing qualifier. `toProviderError` wraps
 * every throwable, including ones `classifyProviderError` had no status for — it
 * returns `provider` as a fall-through default there, which is an absence of
 * classification, not a determination. Treating that as authoritative would
 * silence step 3 in precisely the case it was written for.
 *
 * Returns `false` for all other errors. Safe to call with any value;
 * non-Error inputs hit the stringified-pattern branch and return `false`
 * unless the string happens to match.
 */

import { extractStatus, isProviderError, type ProviderError } from "../providers/errors.js";

const BUDGET_EXCEEDED_PATTERNS = [/budget.?exceeded/i];

/** Max depth walked on the cause chain looking for a structured statusCode. */
const MAX_CAUSE_HOPS = 5;

interface MaybeStatusCodeBearer {
    statusCode?: unknown;
    status?: unknown;
    cause?: unknown;
}

function hasStatus402(err: unknown): boolean {
    let cursor: unknown = err;
    for (let i = 0; i < MAX_CAUSE_HOPS && cursor; i++) {
        const e = cursor as MaybeStatusCodeBearer;
        const code = e.statusCode ?? e.status;
        if (code === 402) return true;
        cursor = e.cause;
    }
    return false;
}

/**
 * Find a `ProviderError` on the value or its cause chain. A `ResultError`
 * thrown at a step boundary carries the structured value on `.cause`, which is
 * the shape the callers of this predicate actually catch.
 */
function findProviderError(err: unknown): ProviderError | undefined {
    let cursor: unknown = err;
    for (let i = 0; i < MAX_CAUSE_HOPS && cursor; i++) {
        if (isProviderError(cursor)) return cursor;
        cursor = (cursor as { cause?: unknown }).cause;
    }
    return undefined;
}

export function isBudgetExceeded(err: unknown): boolean {
    if (hasStatus402(err)) return true;
    const classified = findProviderError(err);
    if (classified) {
        if (classified.type === "budget") return true;
        // `auth` and `tenant-blocked` exist only because a status produced them, and
        // a `provider` arm that carried a status was decided on it. None can be
        // overturned by a phrase inside a response body the message merely quotes.
        //
        // A `provider` arm with NO status is the one exception: there
        // `classifyProviderError` had nothing to key on and applied a fall-through
        // default, so it made no determination to respect. That is exactly the shape
        // a gateway reporting `budget_exceeded` as plain text arrives in, and the
        // patterns below are the reason it is still caught.
        if (classified.type !== "provider" || extractStatus(classified) !== undefined) return false;
    }
    const msg = err instanceof Error ? err.message : String(err ?? "");
    return BUDGET_EXCEEDED_PATTERNS.some((p) => p.test(msg));
}
