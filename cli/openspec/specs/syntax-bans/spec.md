# syntax-bans Specification

## Purpose
The lint entries of `eslint-js/no-restricted-syntax` in the oxlint configuration of cli: the entries that hold the opentui renderer to its theming channels, and the preset bans of an inline regular expression, an unchecked `JSON.parse`, and a raw timer.

## Requirements
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

### Requirement: The regex, JSON.parse, and timer bans report nothing

The oxlint configuration of cli MUST NOT turn off the `regex`, `jsonParse`, or `timers` ban of `eslint-js/no-restricted-syntax`. This applies to the preset call and to each override. The bans report an inline regular expression, an unchecked `JSON.parse`, and a raw `setTimeout` or `setInterval` in the TypeScript source of cli, the tests included. A site that keeps a reported form MUST carry an `oxlint-disable-next-line eslint-js/no-restricted-syntax` directive on the line before it. The directive MUST give a reason after ` -- ` that states why no replacement applies.

#### Scenario: The lint run reports nothing for the three bans

- **WHEN** `bun run lint` runs in `cli/`
- **THEN** `eslint-js/no-restricted-syntax` reports no site, and the lint run passes

#### Scenario: No off entry for the three bans

- **WHEN** a reader reads the oxlint configuration of cli
- **THEN** no option of the preset call and no override turns the `regex`, `jsonParse`, or `timers` ban off

#### Scenario: A kept form names its reason

- **WHEN** a reader searches the TypeScript source under `cli/src/` and `cli/scripts/`, and `cli/oxlint.config.ts`, for a directive that names `eslint-js/no-restricted-syntax`
- **THEN** each such directive is an `oxlint-disable-next-line` with a reason, and no file-level directive turns the rule off
