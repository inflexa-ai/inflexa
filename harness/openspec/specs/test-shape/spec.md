# test-shape Specification

## Purpose

Holds the test-shape rules of the harness oxlint configuration: the two
preset rules that govern the shape of an asynchronous function and the
run of a page script — `typescript/require-await` and
`typescript/no-implied-eval` — stay on in each configuration entry and
report nothing, so each `async` marker reflects a real await and each
`Function` construction in a test names its reason.

## Requirements

### Requirement: The test-shape rules report nothing

The oxlint configuration of the harness MUST NOT turn off
`typescript/require-await` or `typescript/no-implied-eval`, neither in
the preset call nor in an override. The fix shape for a reported site —
a function that drops `async` and returns its value through
`Promise.resolve` or `Promise.reject`, a test double that returns the
value of the real function, or a page script that runs from a fixture or
keeps its disable directive with a named reason — is a design rule of
the adopting change, not a spec obligation.

#### Scenario: The lint run reports nothing for the rules

- **WHEN** `bun run lint` runs in `harness/`
- **THEN** `typescript/require-await` and `typescript/no-implied-eval`
  report no site, and the lint run passes

#### Scenario: No off entry for the rules

- **WHEN** the oxlint configuration of the harness is read
- **THEN** no override turns either rule off
