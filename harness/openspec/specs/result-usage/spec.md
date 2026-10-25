# result-usage Specification

## Purpose

Holds the Result-usage discipline of the harness type check: the
`must-use-result` rule stays on for `src/**` — which holds every test
file of the harness — and the configuration records each consumer name
that a `Result` may flow into, so a deliberate consumption needs no
per-site directive.

## Requirements

### Requirement: must-use-result stays on for src, the tests included

The type check configuration of the harness MUST NOT turn off
`must-use-result`, neither in the preset call nor in an override, and the
`src/**` entry MUST keep the rule on for each file under `src`, every
test file included — no test file of the harness sits outside `src`. The
fix shape for a reported site — a call wrapped in the awaiting helper
that unwraps the ok, a `Result` that flows into a recorded consumer, or
a kept directive with a named reason at a deliberate drop — is a design
rule of the adopting change, not a spec obligation.

#### Scenario: The type check run reports nothing for the rule

- **WHEN** `bun run typecheck` runs in `harness/`
- **THEN** `must-use-result` reports no site, and the run passes

#### Scenario: No off entry for the rule

- **WHEN** the type check configuration of the harness is read
- **THEN** no override turns `must-use-result` off, and the `src/**`
  entry carries the rule at `error` for each file under `src`

### Requirement: The consumers of a Result are recorded

The `must-use-result` entry of the type check configuration MUST name, in
its `consumers` array, each helper or bridge that a `Result` may flow into
as a consumed value, and the comment on the entry MUST state the reason of
each name. As of this change the names are `unwrapOrThrow`, `passGate`,
`deliverNotice`, `keepSuspendingRefusal`, `awaitOk`, and `isResult`.

#### Scenario: A Result that flows into a recorded consumer reports nothing

- **WHEN** a `Result` is a direct argument of a call to one of the recorded
  consumer names
- **THEN** `must-use-result` reports no site for that `Result`
