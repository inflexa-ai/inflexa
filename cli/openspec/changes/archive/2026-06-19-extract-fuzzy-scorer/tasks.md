## 1. Extract the scorer to lib

- [x] 1.1 Create `src/lib/fuzzy.ts` and move `subsequenceScore(query, target): number` from `select_list.tsx` into it verbatim (logic unchanged), exported with a JSDoc block documenting the `-1`/`>=0`/`0`-for-empty contract and the contiguity + early-hit signals.
- [x] 1.2 Confirm `lib/fuzzy.ts` imports nothing from `tui/`, `modules/`, or `db/` (pure strings in, number out).

## 2. Rewire SelectList

- [x] 2.1 In `select_list.tsx`, remove the local `subsequenceScore` and import it from `../../lib/fuzzy.ts`; `rankItems` stays and keeps the `title`-2×-`category` weighting.
- [x] 2.2 Convert the `items.forEach(...)` loop in `rankItems` to a plain `for` loop (per request); behavior unchanged.
- [x] 2.3 Grep the codebase to confirm no other importer referenced the old private scorer; no shim/re-export left behind.

## 3. Pin the contract with tests

- [x] 3.1 Add `"test": "bun test"` to `package.json` scripts (no new dependency — Bun's runner is built in).
- [x] 3.2 Create `src/lib/fuzzy.test.ts` asserting the contract by ordering/sign relationships (not magic score numbers): subsequence match `>= 0`, non-subsequence `=== -1`, empty query `=== 0`, case-insensitive match, `score(contiguous) > score(scattered)`, and start-of-target hit outscoring a mid-string hit.
- [x] 3.3 Cover the `title`-2×-`category` weighting with a test.
  - DONE via the §5 generalization: the weighting now lives in the domain-blind `rankBy` in `lib/fuzzy.ts` and is tested directly in `fuzzy.test.ts` (field-weight ordering, no-match drop, tie order, empty passthrough) — no component mount, which is what made the original `select_list.test.ts` approach awkward.

## 4. Verify

- [x] 4.1 Run `bun test` — all fuzzy contract scenarios pass.
- [x] 4.2 Run `bun run typecheck` and `bun run lint` — clean.
- [x] 4.3 Run `bun run format:file` on the changed `src/` files (`src/lib/fuzzy.ts`, `src/lib/fuzzy.test.ts`, `src/tui/components/select_list.tsx`).

## 5. Generalize the ranker into lib

- [x] 5.1 Add `rankBy<T>(items, query, fields)` + the `RankField<T>` type to `src/lib/fuzzy.ts` — a domain-blind weighted multi-field ranker, behavior-equivalent to the old `rankItems` (sum `score * weight` over matching fields, drop rows with no match, ties keep input order, empty query passes through).
- [x] 5.2 Remove `rankItems` from `select_list.tsx`; the `ranked` memo now calls `rankBy(props.items, query(), [{ get: i => i.title, weight: 2 }, { get: i => i.category ?? "", weight: 1 }])`.
- [x] 5.3 Add `rankBy` tests to `src/lib/fuzzy.test.ts`: field-weight ordering (title beats category-only), no-match rows dropped, tie order preserved, empty query passthrough.
