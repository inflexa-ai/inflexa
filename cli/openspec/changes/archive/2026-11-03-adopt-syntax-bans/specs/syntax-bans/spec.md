## ADDED Requirements

### Requirement: The regex, JSON.parse, and timer bans report nothing

The oxlint configuration of cli MUST NOT turn off the `regex`, `jsonParse`, or `timers` ban of `eslint-js/no-restricted-syntax`. This applies to the preset call and to each override. The bans report an inline regular expression, an unchecked `JSON.parse`, and a raw `setTimeout` or `setInterval` in the TypeScript source of cli, the tests included. A site that keeps a reported form MUST carry an `oxlint-disable-next-line eslint-js/no-restricted-syntax` directive on the line before it. The directive MUST give a reason after ` -- ` that states why no replacement applies. The fix shapes for a reported site are design rules of the change `adopt-syntax-bans` (design D1 to D8), not spec obligations.

#### Scenario: The lint run reports nothing for the three bans

- **WHEN** `bun run lint` runs in `cli/`
- **THEN** `eslint-js/no-restricted-syntax` reports no site, and the lint run passes

#### Scenario: No off entry for the three bans

- **WHEN** a reader reads the oxlint configuration of cli
- **THEN** no option of the preset call and no override turns the `regex`, `jsonParse`, or `timers` ban off

#### Scenario: A kept form names its reason

- **WHEN** a reader searches the TypeScript source under `cli/src/` and `cli/scripts/`, and `cli/oxlint.config.ts`, for a directive that names `eslint-js/no-restricted-syntax`
- **THEN** each such directive is an `oxlint-disable-next-line` with a reason, and no file-level directive turns the rule off
