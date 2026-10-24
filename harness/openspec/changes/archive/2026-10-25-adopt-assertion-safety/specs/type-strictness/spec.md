# Spec Delta

## ADDED Requirements

### Requirement: The assertion-safety rules report nothing

The oxlint configuration of the harness MUST NOT turn off
`@inflexa-ai/require-assertion-safety`, `typescript/no-unsafe-type-assertion`,
or `@inflexa-ai/no-double-cast`. The fix shape for a reported assertion — a
parse or guard at the boundary that owns the data, a type that carries the
narrowing, or a kept `SAFETY:` comment only where a real invariant that no
type can carry holds — is a design rule of the adopting change (design.md,
D2), not a spec obligation.

#### Scenario: The lint run reports nothing for the rules

- **WHEN** `bun run lint` runs in `harness/`
- **THEN** each of the three rules reports no site, and the lint run passes

#### Scenario: No blanket off entry for the rules

- **WHEN** the oxlint configuration of the harness is read
- **THEN** no override turns any of the three rules off
