# fuzzy-scoring — delta

## MODIFIED Requirements

### Requirement: Shared, dependency-free subsequence scorer

The system SHALL provide `subsequenceScore(query: string, target: string): number` in `src/lib/fuzzy.ts` as pure, non-domain infrastructure. It SHALL import nothing from `src/tui/`, `src/modules/`, or `src/db/`, and SHALL be the single scoring primitive that the list primitives' (`FixedList`/`DynamicList`) row ranking calls via `rankBy`. Introducing it SHALL add no new runtime dependency — no fuzzy-search library.

#### Scenario: Lives in lib as pure infrastructure

- **WHEN** the scorer is invoked
- **THEN** it is imported from `src/lib/fuzzy.ts`, takes only the two strings, returns a number, and reaches into no `tui/`, `modules/`, or `db/` code

#### Scenario: No new dependency

- **WHEN** the dependency manifest is inspected after the change
- **THEN** no fuzzy-search package has been added; the scorer is hand-written
