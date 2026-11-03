# test-shape Specification

## Purpose
Holds the test-shape rules of the cli oxlint configuration: `typescript/require-await` and `typescript/no-implied-eval` stay on and report nothing. Thus each `async` marker in cli reflects a real await or carries a stated reason, and no code runs a string as code.

## Requirements
### Requirement: The test-shape rules report nothing

The oxlint configuration of cli MUST NOT turn off `typescript/require-await` or `typescript/no-implied-eval`, neither in the preset call nor in an override. The rules apply to the TypeScript source of cli, the tests included. A site that keeps a reported form MUST carry an `oxlint-disable-next-line` directive on the line before it. The directive MUST give a reason after ` -- ` that states why no other form applies. The fix shapes for a reported site are design rules of the change `adopt-test-shape-rules` (design D1 to D7), not spec obligations.

#### Scenario: The lint run reports nothing for the rules

- **WHEN** `bun run lint` runs in `cli/`
- **THEN** `typescript/require-await` and `typescript/no-implied-eval` report no site, and the lint run passes

#### Scenario: No off entry for the rules

- **WHEN** a reader reads the oxlint configuration of cli
- **THEN** no option of the preset call and no override turns either rule off

#### Scenario: A kept form names its reason

- **WHEN** a reader searches the TypeScript source under `cli/src/` and `cli/scripts/`, and the TypeScript files at the root of `cli/`, for a directive that names `typescript/require-await` or `typescript/no-implied-eval`
- **THEN** each such directive is an `oxlint-disable-next-line` with a reason, and no file-level directive turns either rule off
