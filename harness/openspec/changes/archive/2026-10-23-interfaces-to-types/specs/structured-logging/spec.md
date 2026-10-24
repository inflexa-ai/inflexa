## MODIFIED Requirements

### Requirement: Operational logging goes through an injected host-agnostic Logger

The harness SHALL define its own `Logger` type and SHALL NOT depend on a
concrete logging library — neither at runtime nor in its exported type surface.
The type SHALL expose `debug`/`info`/`warn`/`error` taking the message
first and optional structured fields second (`error(msg, fields?)`), plus
`with(fields)` returning a `Logger` that carries those fields on every
subsequent record. Message-first ordering is normative: it matches the
prevailing convention (`slog`, winston, `console`) and keeps the published
surface independent of any one embedder's logger.

Every harness module that logs SHALL receive a `Logger` as an injected
construction-time dependency, carried on the module's existing deps or input
object.

`bootHarness` SHALL require it: an embedder that boots the harness has exactly
one place to decide where diagnostics go, and that decision should be conscious
rather than defaulted. Every module deps bag below it SHALL accept it
**optionally** and the harness SHALL substitute a no-op realization when it is
absent, so internal call sites log unconditionally rather than threading optional
chaining through every diagnostic, and so a partially-wired bundle degrades
instead of failing.

The fallback SHALL NOT be `console`: a host whose UI owns stdout discards console
output, so the write succeeds and the record is gone — silence is at least an
honest signal, whereas a discarded write is indistinguishable from a working one.

#### Scenario: Booting without a logger is a compile-time error

- **GIVEN** an embedder calling `bootHarness`
- **WHEN** it omits `logger`
- **THEN** the build fails — the entry point does not default the decision

#### Scenario: The harness declares no logging-library dependency

- **WHEN** `harness/package.json` and `harness/src` are inspected
- **THEN** no logging library appears in `dependencies`, and no source file imports one — including as a type-only import

#### Scenario: A module logs through its injected Logger

- **GIVEN** a sandbox step whose deps carry a `Logger`
- **WHEN** the step reports a failure
- **THEN** the record is written through the injected `Logger` and no `console` method is called

#### Scenario: Contextual binding carries fields onto every record

- **GIVEN** a `Logger` bound via `with({ runId, stepId })`
- **WHEN** `error("lineage_attestation failure", { errorClass })` is called on it
- **THEN** the emitted record carries `runId`, `stepId`, and `errorClass` as structured fields

#### Scenario: An omitted logger degrades to no-op, not to console

- **GIVEN** an embedder that wires no `logger`
- **WHEN** a component on that path logs a warning
- **THEN** the record is discarded and no `console` method is called, and the component does not fail for the absence of a logger
