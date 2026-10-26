# Spec Delta

## ADDED Requirements

### Requirement: The remaining preset rules report nothing

The oxlint configuration of the harness MUST NOT turn off any rule of the
preset that the `#609` block still held off. Two recorded exceptions exist
and no other: the two bun-types rules `typescript/await-thenable` and
`typescript/no-confusing-void-expression` stay off for the test globs only,
because bun-types types `expect().rejects.toThrow()` as `void`; and a
deliberate site that no fix the rule offers can express keeps a named
exception — an inline `oxlint-disable … -- <reason>` for a `typescript/*`
rule, or a zone block in the configuration that names exactly one rule and
carries a reason for each file it covers, for an `@inflexa-ai/*` rule, which
the plugin's architecture-directives layer keeps out of inline disables.

#### Scenario: The lint run reports nothing outside the recorded exceptions

- **WHEN** `bun run lint` runs in `harness/`
- **THEN** each rule of the removed block reports no site, the run passes,
  and the only off entries for the rules of the block are the bun-types
  test-glob block and the zone blocks that name one rule and carry a reason
  per file

#### Scenario: No blanket off entry remains from the umbrella block

- **WHEN** the oxlint configuration of the harness is read
- **THEN** no override turns off any preset rule outside the test globs of
  the two bun-types rules and the zone blocks that name one rule and carry a
  reason per file

#### Scenario: The instance-of-error option names its modules

- **WHEN** the oxlint configuration of the harness is read
- **THEN** `@inflexa-ai/no-instanceof-error` carries an `allowIn` list that
  names the modules that normalize an arbitrary thrown value, and each entry
  states the reason beside it
