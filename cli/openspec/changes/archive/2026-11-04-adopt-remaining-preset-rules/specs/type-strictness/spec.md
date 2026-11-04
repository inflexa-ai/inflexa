## ADDED Requirements

### Requirement: The remaining preset rules report nothing

The oxlint configuration of cli MUST NOT turn off a rule of the preset outside two recorded exceptions:

- The two bun-types rules `typescript/await-thenable` and `typescript/no-confusing-void-expression` stay off for the test globs only, because bun-types types `expect().rejects.toThrow()` as `void`.
- A deliberate site keeps a named exception when each fix of the rule would remove its form or change its behavior. For a `typescript/*` rule, the exception is an inline `oxlint-disable-next-line <rule> -- <reason>`. For an `@inflexa-ai/*` rule, which the architecture-directives layer of the plugin keeps out of inline directives, the exception is a zone block in the configuration that names exactly one rule and carries a reason for each file that it covers.

The rule `@inflexa-ai/no-instanceof-error` MUST carry an `allowIn` list that names only the modules that normalize an arbitrary thrown value, with the reason of each entry beside it. The fix shapes for a reported site are design rules of the change `adopt-remaining-preset-rules` (design D1 to D15), not spec obligations.

#### Scenario: The lint run reports nothing outside the recorded exceptions

- **WHEN** `bun run lint` runs in `cli/`
- **THEN** no preset rule reports a site, and the lint run passes

#### Scenario: No blanket off entry remains

- **WHEN** a reader reads the oxlint configuration of cli
- **THEN** no override turns a preset rule off, except the bun-types block of the test globs and the zone blocks that name one rule and carry a reason for each file

#### Scenario: The instance-of-error option names its modules

- **WHEN** a reader reads the oxlint configuration of cli
- **THEN** `@inflexa-ai/no-instanceof-error` carries an `allowIn` list, through the `instanceofErrorAllowIn` option of the preset, and each entry states its reason beside it

#### Scenario: A kept typescript rule site names its reason

- **WHEN** a reader searches the TypeScript source under `cli/src/` and `cli/scripts/` for a directive that names a rule of the preset
- **THEN** each such directive is an `oxlint-disable-next-line` with a reason after ` -- `, and no directive names an `@inflexa-ai/*` rule
