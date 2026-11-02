# agent-command-policy Specification

## MODIFIED Requirements

### Requirement: Static enforcement makes an unclassified command a build failure

Beyond the compile-time helper, the system SHALL enforce policy exhaustiveness statically: a lint restriction scoped to the command registry (entries of `eslint-js/no-restricted-syntax` in `oxlint.config.ts`) SHALL forbid raw commander `.action(` registration (the helper is the only path), and a CI test SHALL walk the full `buildProgram()` tree — with the dev channel forced both on and off — asserting every action-classified leaf carries a policy and a command kind. A snapshot test SHALL pin the derived table of `subcommand path → policy kind (and safeFlags for auto)` so any policy change surfaces as a reviewable one-file diff. A second snapshot SHALL pin the table of `subcommand path → command kind (and the machine options of an instance command)`, and each machine option SHALL name an option that the command declares. Validation SHALL live in lint and tests, never in `buildProgram()` itself — a policy mistake must not brick the CLI at startup for human use.

#### Scenario: A raw action registration is a lint error

- **WHEN** a command in the registry is given an action handler via commander's `.action()` directly instead of the policy-taking helper
- **THEN** the lint fails the build

#### Scenario: The tree walk catches a policy-less leaf in either channel

- **WHEN** the exhaustiveness test walks the command tree with dev-channel commands enabled and again with them disabled
- **THEN** it fails if any action-classified leaf command lacks a stamped policy or a stamped command kind

#### Scenario: A policy change is a visible audit diff

- **WHEN** any command's policy kind or safeFlags change
- **THEN** the policy snapshot test fails until its expected table is consciously updated in review

#### Scenario: A kind change is a visible audit diff

- **WHEN** a command's command kind or its machine options change
- **THEN** the kind snapshot test fails until its expected table is consciously updated in review
