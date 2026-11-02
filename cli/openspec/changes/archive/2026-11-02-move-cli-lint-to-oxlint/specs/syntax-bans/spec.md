# syntax-bans Specification

## ADDED Requirements

### Requirement: The opentui renderer bans stay armed

The oxlint configuration of cli MUST keep the two entries of `eslint-js/no-restricted-syntax` that hold the opentui renderer to its theming channels: a literal that names a hex color MUST NOT appear in the TUI source, and a literal that inlines a non-ASCII glyph MUST NOT appear in the TUI source. A literal is a string literal, a template text, or a JSX text child. The hex entry reports a literal whose whole value, without the surrounding white space, is `#` and 3, 4, 6, or 8 hex digits. The TUI source is each non-test file under `src/tui/`; the theme palettes live outside it, in `src/lib/design_system.ts`. The exemptions are the documented sanctions: the test files (they assert on resolved colors and frames), and the prose punctuation — the em dash, the ellipsis, the middle dot, and the right arrow — which prose strings may carry. Neither entry may be switched off, narrowed to nothing, or scoped away in the configuration.

#### Scenario: The lint run reports nothing for the two bans

- **WHEN** `bun run lint` runs in `cli/`
- **THEN** neither opentui renderer entry of `eslint-js/no-restricted-syntax` reports a site, and the lint run passes

#### Scenario: An inlined hex color is a report

- **WHEN** a string literal, a template text, or a JSX text child whose whole value is a hex color appears in a non-test file under `src/tui/`
- **THEN** `bun run lint` reports the literal under the hex entry

#### Scenario: An inlined glyph is a report

- **WHEN** a literal with a non-ASCII glyph appears in a non-test file under `src/tui/` and the literal's non-ASCII content is not only sanctioned prose punctuation
- **THEN** `bun run lint` reports the literal under the glyph entry
