## Why

The subsequence fuzzy scorer that ranks every `SelectList` row is a private, untested function buried in `select_list.tsx`. We deliberately rejected adopting a fuzzy-search library (uFuzzy/Fuse): at our scale (≤ a few hundred rows) a library's performance advantage is unobservable and its matching model is a worse fit than our loose subsequence. But the hand-rolled scorer's ranking semantics are unprotected — a future edit can silently regress them (the "brittleness" worry). Extracting the pure scoring math to shared infra and pinning its contract with tests removes that risk without a dependency.

## What Changes

- Move the pure `subsequenceScore(query, target): number` out of `src/tui/components/select_list.tsx` into a new `src/lib/fuzzy.ts` (non-domain infrastructure), exported with a JSDoc block.
- Generalize the `SelectItem`-coupled `rankItems` into a domain-blind `rankBy<T>(items, query, fields)` and move it to `lib/fuzzy.ts` too. Callers pass a weighted accessor list (e.g. `[{ get: i => i.title, weight: 2 }, { get: i => i.category ?? "", weight: 1 }]`); `SelectList` calls it with exactly that list. The accessor form removes the `SelectItem` coupling that previously would have forced `lib/` to import a `tui/` type — `rankBy<T>` stays pure infra.
- Add `src/lib/fuzzy.test.ts` pinning both contracts: the scorer (subsequence existence, consecutive-run beats scattered, early-hit bonus, case-insensitivity, empty-query neutrality) and the ranker (field weighting — title beats category-only, no-match rows dropped, ties keep original order, empty query passes through).
- Add a `test` script (`bun test`) to `package.json`. No new dependency — Bun's test runner is built in.
- No behavior change: filtering and ranking in the command palette and every dialog picker are identical to today.

## Capabilities

### New Capabilities
- `fuzzy-scoring`: the shared subsequence scorer in `src/lib/fuzzy.ts` — its match-and-rank contract (the scoring signals) and the tests that lock that contract against regression.

### Modified Capabilities
- `tui-components`: `SelectList`'s fuzzy scorer is no longer a private, co-located function — both the scorer and the (now generalized) ranker move to `lib/fuzzy.ts`, and `SelectList` delegates ranking to `rankBy` via an accessor list. Observable behavior is unchanged.
- `command-palette`: the "inline" subsequence scorer is now the shared `lib/fuzzy.ts` scorer. Still no new dependencies; title-over-category ranking is unchanged.

## Impact

- Code: `src/tui/components/select_list.tsx` (loses `subsequenceScore` and `rankItems`, delegates to `rankBy`); new `src/lib/fuzzy.ts` (`subsequenceScore` + `rankBy`/`RankField`); new `src/lib/fuzzy.test.ts`; `package.json` (adds a `test` script).
- Dependencies: none added — explicitly no fuzzy-search library; Bun's test runner needs no package.
- Specs: new `fuzzy-scoring`; surgical deltas to `tui-components` and `command-palette`.
- Users: no runtime or behavior change. Purely structural plus new test coverage.
