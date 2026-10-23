# Spec Delta

## MODIFIED Requirements

### Requirement: Harness source is free of console statements

`harness/src` SHALL NOT call `console.*` for diagnostics. The prohibition SHALL
be enforced by a `no-console` lint rule configured in `harness/oxlint.config.ts`,
scoped to permit the console realization and its test alone, rather than by
per-site suppressions or review discipline.

#### Scenario: A new console call fails lint

- **GIVEN** a source file under `harness/src` other than the console realization and its test
- **WHEN** it adds a `console.warn` call and lint runs
- **THEN** lint fails

#### Scenario: The console realization is permitted

- **WHEN** lint runs over the `createConsoleLogger` source and its test
- **THEN** it passes, because the rule's configuration exempts those files
