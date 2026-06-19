## Context

`SelectList` (`src/tui/components/select_list.tsx`) ranks rows with a hand-rolled subsequence scorer split across two private functions:

- `subsequenceScore(query, target): number` — the scoring math. Pure, string-in/number-out, zero imports. Returns `-1` for no match, else higher-is-better, rewarding consecutive runs and an early first hit.
- `rankItems(items, query): SelectItem<T>[]` — glue that calls the scorer over each row's `title` (weighted 2×) and `category`, then sorts.

We evaluated replacing this with a fuzzy-search library (uFuzzy, Fuse.js) and rejected it: at our scale (command palette ≈ 15 rows, theme picker = 10, analyses/sessions ≈ tens–low hundreds) a library's performance advantage is unobservable, and uFuzzy's tighter matching model is a worse fit than our loose subsequence for acronym-style palette typing. The real worry the library was meant to address — that the hand-rolled heuristic is "brittle" and a future edit could silently regress its ranking — is better solved by pinning the contract with tests than by importing a dependency.

## Goals / Non-Goals

**Goals:**
- Relocate the scoring math (`subsequenceScore`) and the multi-field ranker (as a domain-blind `rankBy<T>`) to shared infrastructure (`src/lib/fuzzy.ts`) so both are testable in isolation, without dragging the Solid/opentui rendering stack into a test.
- Pin both the scorer's and the ranker's behavioral contracts with unit tests so the ranking semantics — including the title-over-category weighting — cannot regress unnoticed.
- Change zero observable behavior in the palette or any dialog picker.

**Non-Goals:**
- Adding a fuzzy-search dependency (explicitly rejected).
- Adding typo tolerance, match highlighting, multi-term matching, or DP-optimal ranking. These were discussed as future options; none are in scope here.
- A performance benchmark. Scale makes raw speed a non-issue; the tests defend the *contract*, not throughput.

## Decisions

**Decision: Move the scorer to lib AND generalize `rankItems` into a domain-blind `rankBy<T>`.**
The pure `subsequenceScore` (strings in, number out) moves to `lib/fuzzy.ts` directly. `rankItems` reads `SelectItem<T>.title`/`.category` — `SelectItem` is a presentation type defined in `select_list.tsx` — so moving it verbatim would make `lib/` import a `tui/` type, inverting the mandated infra→presentation direction (`lib/` must never import `tui/`; `src/lib/` has zero such imports). The fix is to generalize rather than relocate-as-is: `rankBy<T>(items, query, fields)` takes a weighted accessor list (`RankField<T> = { get: (item: T) => string; weight: number }`) so it knows nothing about `SelectItem` or field names. `SelectList` supplies `[{ get: i => i.title, weight: 2 }, { get: i => i.category ?? "", weight: 1 }]`. Both functions then live in `lib/fuzzy.ts`, and `rankBy<T>` stays pure infra.
- *Behavior preservation*: the old `rankItems` used an `if/else` that required a title match for the 2× path and fell back to a category-only score. The generalized form — sum `score * weight` over matching fields, keep the row only if at least one field matched — is exactly equivalent (a non-matching field contributes nothing; a row with no matching field is dropped) and reads cleaner.
- *Alternative considered — keep `rankItems` in the component* (the original plan): avoids the generic-accessor indirection, but leaves the `title`-2×-`category` weighting untestable in isolation — the very thing that motivated this change (pinning the ranking against regression). Because `rankBy` is a generic primitive added to the existing `fuzzy.ts` (not a new single-caller file) and it closes the weighting-test gap, the generalization earns its place over keeping concrete glue in the component.

**Decision: Home it in `src/lib/fuzzy.ts` as non-domain infrastructure.**
`lib/` is for non-domain infra with no single owner (`env.ts`, `config.ts`, …). A pure string-ranking primitive fits there. Although it has one caller today, the move is justified by testability (a `.ts` pure function vs. a function trapped inside a `.tsx` component) — the same reason the repo allows a new file when a real reusable boundary exists.

**Decision: Tests pin the contract, using Bun's built-in runner.**
`bun test` ships with the runtime — no new dependency, no config. Add a `test` script to `package.json`. Tests assert the *signals* that define correct ranking, not exact score numbers (so the implementation can be tuned without rewriting tests against magic constants): for `subsequenceScore` — existence/non-match, consecutive-run beats scattered, early-hit (index-0) bonus, case-insensitivity, and empty-query neutrality (`0`); for `rankBy` — a higher-weighted field beating a lower one (title over category-only), rows matching no field dropped, ties preserving original order, and an empty query passing through unchanged. Because `rankBy` is now a pure lib function, the `title`-2×-`category` weighting is tested directly in `fuzzy.test.ts` with no component mount — so the originally-optional `select_list.test.ts` is unnecessary.

## Risks / Trade-offs

- **[Spec churn for a no-behavior-change move]** → Two existing specs (`tui-components`, `command-palette`) describe the scorer as "private"/"inline". Surgical deltas update only those locality clauses; observable-behavior requirements are untouched, keeping the specs honest without overstating the change.
- **[Asserting magic numbers makes tests brittle in a different way]** → Tests assert ordering/sign relationships (`score(consecutive) > score(scattered)`, `score(match) >= 0`, `score("", x) === 0`), never literal scores, so re-tuning the scorer doesn't force a test rewrite.
- **[`rankBy` is a generic, single-caller primitive — speculative generality vs the repo's "don't extract single-caller helpers" rule]** → It supports N weighted fields though `SelectList` passes exactly two, and has one caller today. Accepted because it is added to the existing `fuzzy.ts` (not a new single-caller file), it removes the `SelectItem`→`lib/` coupling cleanly, and it puts the title-over-category weighting under test — the regression guard that motivated the whole change. If no second caller appears, the only cost is one extra generic parameter; the testability benefit stands regardless.
