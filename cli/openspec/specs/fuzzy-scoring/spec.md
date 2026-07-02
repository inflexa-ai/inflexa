# fuzzy-scoring Specification

## Purpose
TBD - created by archiving change extract-fuzzy-scorer. Update Purpose after archive.
## Requirements
### Requirement: Shared, dependency-free subsequence scorer

The system SHALL provide `subsequenceScore(query: string, target: string): number` in `src/lib/fuzzy.ts` as pure, non-domain infrastructure. It SHALL import nothing from `src/tui/`, `src/modules/`, or `src/db/`, and SHALL be the single scoring primitive that the list primitives' (`FixedList`/`DynamicList`) row ranking calls via `rankBy`. Introducing it SHALL add no new runtime dependency — no fuzzy-search library.

#### Scenario: Lives in lib as pure infrastructure

- **WHEN** the scorer is invoked
- **THEN** it is imported from `src/lib/fuzzy.ts`, takes only the two strings, returns a number, and reaches into no `tui/`, `modules/`, or `db/` code

#### Scenario: No new dependency

- **WHEN** the dependency manifest is inspected after the change
- **THEN** no fuzzy-search package has been added; the scorer is hand-written

### Requirement: Subsequence match-or-reject contract

The scorer SHALL return a score of `0` or greater when `query` is, case-insensitively, a subsequence of `target` (every `query` character appears in `target` in order), and SHALL return `-1` when it is not. An empty `query` SHALL return the neutral score `0`. Matching SHALL be case-insensitive.

#### Scenario: Subsequence matches

- **WHEN** `query` is a case-insensitive subsequence of `target` (e.g. `"tn"` against `"tokyo-night"`)
- **THEN** the score is `>= 0`

#### Scenario: Non-subsequence is rejected

- **WHEN** `query` is not a subsequence of `target` (e.g. `"zx"` against `"tokyo-night"`)
- **THEN** the score is `-1`

#### Scenario: Empty query is neutral

- **WHEN** `query` is the empty string
- **THEN** the score is `0`, regardless of `target`

#### Scenario: Matching ignores case

- **WHEN** `query` and `target` differ only in case (e.g. `"OP"` against `"Open output"`)
- **THEN** the match still scores `>= 0`

### Requirement: Ranking signals reward contiguity and early hits

Among matching pairs, the scorer SHALL rank a more contiguous match strictly above a more scattered one for the same `query`, and SHALL reward a match whose first hit is at the start of `target`. These signals define the relative ordering; exact score magnitudes are not specified.

#### Scenario: Consecutive beats scattered

- **WHEN** the same `query` matches one `target` contiguously and another `target` with gaps (e.g. `"cat"` against `"cat"` vs `"c_a_t"`)
- **THEN** the contiguous match scores strictly higher

#### Scenario: Early hit is rewarded

- **WHEN** `query` matches at the very start of one `target` and mid-string in another
- **THEN** the start-of-target match scores higher

### Requirement: Weighted multi-field ranker

The system SHALL provide `rankBy<T>(items, query, fields)` in `src/lib/fuzzy.ts`, where `fields` is a list of `{ get: (item: T) => string; weight: number }` accessors. It SHALL score each item by summing `subsequenceScore(query, get(item)) * weight` over every field that matches (score `>= 0`), keep an item only if at least one field matched, and return the kept items sorted best-score-first with ties resolved by original input order. An empty or whitespace-only `query` SHALL return `items` unchanged. `rankBy` SHALL remain domain-blind — it SHALL know nothing about `SelectItem` or any field name, so it imports nothing from `tui/`.

#### Scenario: A higher-weighted field outranks a lower one

- **WHEN** one item matches `query` only on a low-weight field and another matches on a higher-weight field (e.g. title weighted above category)
- **THEN** the item matched on the higher-weight field is ranked first

#### Scenario: Items matching no field are dropped

- **WHEN** an item matches `query` on none of its fields
- **THEN** it is absent from the result

#### Scenario: Ties keep original order

- **WHEN** two items score equally
- **THEN** they appear in their original input order (grouping/order is preserved)

#### Scenario: Empty query passes through

- **WHEN** `query` is empty or only whitespace
- **THEN** `items` are returned unchanged in their original order

### Requirement: Scoring contract is regression-locked by tests

The contract above SHALL be exercised by a test suite runnable via `bun test`, wired as the `test` script in `package.json`. The test runner SHALL be Bun's built-in runner, adding no new dependency.

#### Scenario: bun test runs the contract suite

- **WHEN** `bun test` is run
- **THEN** the `src/lib/fuzzy.test.ts` suite executes and asserts the scorer scenarios (match, rejection, empty-query, case-insensitivity, contiguity, early-hit) and the ranker scenarios (field-weight ordering, no-match drop, tie order, empty-query passthrough) above

