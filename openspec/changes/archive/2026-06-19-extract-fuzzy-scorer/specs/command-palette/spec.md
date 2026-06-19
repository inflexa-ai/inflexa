## MODIFIED Requirements

### Requirement: Inline fuzzy ranking without new dependencies

Palette filtering SHALL use a small subsequence scorer — the shared `subsequenceScore` in `src/lib/fuzzy.ts` — that ranks `title` matches above `category` matches; an empty query SHALL list all enabled commands grouped by category. The feature SHALL add no new dependencies — neither a fuzzy-search library nor `@opentui/keymap`.

#### Scenario: Subsequence match ranks by title

- **WHEN** the query is a subsequence of a command's title
- **THEN** that command appears, ranked above commands matched only on category

#### Scenario: Empty query lists all grouped

- **WHEN** the query is empty
- **THEN** every enabled command is shown, grouped by category
