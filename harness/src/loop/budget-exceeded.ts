/**
 * HTTP 402 `budget_exceeded` classifier.
 *
 * Detects when an LLM call failed because the billing gateway reported the
 * caller's budget was exhausted. This is NOT a transient error — retrying
 * is wasteful because every subsequent call charged to the same budget will
 * also fail until the user tops up.
 *
 * Classification order (first hit wins):
 *   1. Structured `statusCode === 402` (or `status === 402`) on any
 *      link of the cause chain. The gateway emits 402 exclusively for
 *      `budget_exceeded`, so a structured 402 is unambiguous.
 *   2. Pattern fallback: `/budget.?exceeded/i` on the stringified
 *      top-level error message. Covers stringified throws and paths
 *      where no `statusCode` is attached (ops scripts, sandbox-server
 *      surfacing upstream billing errors as text).
 *
 * Returns `false` for all other errors. Safe to call with any value;
 * non-Error inputs hit the stringified-pattern branch and return `false`
 * unless the string happens to match.
 */

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

export function isBudgetExceeded(err: unknown): boolean {
    if (hasStatus402(err)) return true;
    const msg = err instanceof Error ? err.message : String(err ?? "");
    return BUDGET_EXCEEDED_PATTERNS.some((p) => p.test(msg));
}
