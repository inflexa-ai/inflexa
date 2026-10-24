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
