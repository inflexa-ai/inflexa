# Spec Delta

## Purpose

Holds the syntax bans of the harness oxlint configuration: the four
shapes that the preset forbids — an inline regular expression, an
unchecked `JSON.parse`, a raw timer, and a `forEach` call — stay on in
each configuration entry and report nothing, so a pattern, a parse, and a
wait each carry a name and a stated reason where one survives.

## ADDED Requirements

### Requirement: The syntax bans report nothing

The oxlint configuration of the harness MUST NOT turn off the `regex`,
`jsonParse`, `timers`, or `forEach` ban of
`eslint-js/no-restricted-syntax`, neither in the preset call nor in an
override. The fix shape for a reported site — a parser, a schema, or a
builtin in place of a pattern; a schema parse at the boundary in place of
an unchecked `JSON.parse`; and a wait that ends on an `AbortSignal` or an
injected clock in place of a raw timer — is a design rule of the
adopting change, not a spec obligation.

#### Scenario: The lint run reports nothing for the bans

- **WHEN** `bun run lint` runs in `harness/`
- **THEN** `eslint-js/no-restricted-syntax` reports no site, and the lint
  run passes

#### Scenario: No off entry for the bans

- **WHEN** the oxlint configuration of the harness is read
- **THEN** no option of the preset call and no override turns any of the
  four bans off
