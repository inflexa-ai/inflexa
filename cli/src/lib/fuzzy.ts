// Non-domain fuzzy primitive: the subsequence scorer that ranks searchable lists. It lives in
// `lib/` (not beside its list-primitive callers in `tui/components/`) so the scoring math is
// testable in isolation, without dragging the Solid/opentui rendering stack into a test. The
// `SelectItem`-aware field weighting stays in `list_core.tsx` — moving it here would make `lib/`
// import a `tui/` type, inverting the infra→presentation dependency direction.

/**
 * Score a subsequence match of `query` against `target`: `-1` when `query` is not a
 * subsequence of `target` (case-insensitively), otherwise a non-negative score where higher is
 * better. An empty `query` is the neutral `0` (everything matches).
 *
 * Consecutive hits and a first hit at the start of `target` are rewarded, so `"op"` ranks
 * `"Open…"` above a scattered match. The exact magnitudes are unspecified — callers may rely
 * only on the sign and the relative ordering (contiguous beats scattered, an early hit beats a
 * late one).
 */
export function subsequenceScore(query: string, target: string): number {
    if (query === "") return 0;
    const q = query.toLowerCase();
    const t = target.toLowerCase();
    let qi = 0;
    let score = 0;
    let streak = 0;
    let last = -2;
    for (let ti = 0; ti < t.length && qi < q.length; ti++) {
        if (t[ti] === q[qi]) {
            streak = ti === last + 1 ? streak + 1 : 1;
            score += streak + (ti === 0 ? 5 : 0);
            last = ti;
            qi++;
        }
    }
    return qi === q.length ? score : -1;
}

/** A weighted field to fuzzy-match against in {@link rankBy}. */
export type RankField<T> = {
    /** Extracts the string to match for this field from an item (e.g. `(i) => i.title`). */
    get: (item: T) => string;
    /** Multiplier on this field's score — a higher weight lets this field dominate the ranking. */
    weight: number;
};

/**
 * Rank `items` by a fuzzy match of `query` across one or more weighted string `fields`, best
 * first. Each matching field contributes `subsequenceScore(query, field) * weight`; an item is
 * kept only if at least one field matches. Ties preserve the original order, so a stable input
 * order (e.g. category grouping) survives. An empty or whitespace-only `query` returns `items`
 * unchanged.
 */
export function rankBy<T>(items: readonly T[], query: string, fields: RankField<T>[]): readonly T[] {
    const q = query.trim();
    if (q === "") return items;
    const scored: Array<{ item: T; score: number; i: number }> = [];
    for (let i = 0; i < items.length; i++) {
        const item = items[i]!; // bounded by items.length, never undefined
        let score = 0;
        let matched = false;
        for (const field of fields) {
            const s = subsequenceScore(q, field.get(item));
            if (s >= 0) {
                score += s * field.weight;
                matched = true;
            }
        }
        if (matched) scored.push({ item, score, i });
    }
    scored.sort((a, b) => b.score - a.score || a.i - b.i);
    return scored.map((s) => s.item);
}
