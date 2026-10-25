# Spec Delta

## ADDED Requirements

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
