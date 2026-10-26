# type-strictness Specification

## Purpose

Records the compiler strictness and the lint rules that make harness state
its index accesses, carry no unchecked value, and assert no type without a
check that carries it, and holds the decisions that `exactOptionalPropertyTypes`
stays off and that an assertion survives only behind a stated invariant.

## Requirements

### Requirement: The typecheck program models a missed index read

The TypeScript program of the harness MUST check `src` and `scripts/**/*.ts`
with `noUncheckedIndexedAccess` on, so an index read types as
`T | undefined` and code that consumes it narrows or restructures the access.
`tsconfig.build.json` extends the same options, thus a declaration emitted to
`dist/` comes from a program compiled under the flag.

#### Scenario: An unchecked index read fails the typecheck

- **WHEN** a file of the program reads a member of an array or a record and
  uses it as if it cannot be `undefined`
- **THEN** `bun run typecheck` reports the read

#### Scenario: A script file is part of the program

- **WHEN** `bun run typecheck` runs in `harness/`
- **THEN** each file of `scripts/**/*.ts` is checked under the same flag as
  `src`

### Requirement: exactOptionalPropertyTypes stays off

The TypeScript program of the harness MUST NOT set
`exactOptionalPropertyTypes`. The recorded reason (issue #705, 2026-10-23): a
missing key and a key with the value `undefined` mean the same in the harness
while `@inflexa-ai/no-conditional-spread` prescribes the direct property
assignment as its fix, and widening each optional property to
`?: T | undefined` would restore the equivalence the flag exists to remove.

#### Scenario: The flag is absent from the program options

- **WHEN** the compiler options of `harness/tsconfig.json` are read
- **THEN** they contain no `exactOptionalPropertyTypes` entry

### Requirement: The assertion-safety rules report nothing

The oxlint configuration of the harness MUST NOT turn off
`@inflexa-ai/require-assertion-safety`, `typescript/no-unsafe-type-assertion`,
or `@inflexa-ai/no-double-cast`. The fix shape for a reported assertion — a
parse or guard at the boundary that owns the data, a type that carries the
narrowing, or a kept `SAFETY:` comment only where a real invariant that no
type can carry holds — is a design rule of the adopting change
(openspec/changes/archive/2026-10-25-adopt-assertion-safety, design D2),
not a spec obligation.

#### Scenario: The lint run reports nothing for the rules

- **WHEN** `bun run lint` runs in `harness/`
- **THEN** each of the three rules reports no site, and the lint run passes

#### Scenario: No blanket off entry for the rules

- **WHEN** the oxlint configuration of the harness is read
- **THEN** no override turns any of the three rules off

### Requirement: The unchecked-value rules report nothing

The oxlint configuration of the harness MUST NOT turn off
`typescript/no-unsafe-call`, `typescript/no-unsafe-member-access`,
`typescript/no-unsafe-assignment`, `typescript/no-unsafe-return`,
`typescript/no-unsafe-argument`, or `@inflexa-ai/no-conditional-spread`.
The fix shape for a conditional spread is a design rule of the adopting
change (openspec/changes/archive/2026-10-24-adopt-index-access-strictness,
design D3), not a spec obligation.

#### Scenario: The lint run reports nothing for the rules

- **WHEN** `bun run lint` runs in `harness/`
- **THEN** each of the six rules reports no site, and the lint run passes

#### Scenario: No blanket off entry for the rules

- **WHEN** the oxlint configuration of the harness is read
- **THEN** no override turns any of the six rules off

### Requirement: The stated-access rules report nothing

The oxlint configuration of the harness MUST NOT turn off
`typescript/no-non-null-assertion`,
`typescript/no-unnecessary-type-assertion`, or
`typescript/no-unnecessary-condition`. The fix shape for a reported site — a
narrowing, a restructured access, a throwing read helper, a deleted dead
condition, or a corrected type — is a design rule of the adopting change, not
a spec obligation.

#### Scenario: The lint run reports nothing for the rules

- **WHEN** `bun run lint` runs in `harness/`
- **THEN** each of the three rules reports no site, and the lint run passes

#### Scenario: No blanket off entry for the rules

- **WHEN** the oxlint configuration of the harness is read
- **THEN** no override turns any of the three rules off

#### Scenario: No non-null assertion remains in the shipped source

- **WHEN** the TypeScript source under `src/` and `scripts/` of the harness
  is read
- **THEN** no non-null assertion expression remains (logical negation is
  not an assertion and stays)

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
