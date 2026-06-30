# structured-logging Specification

## Purpose

The harness logs operationally through **pino**, the structured JSON logger, and
treats the logger as an injected dependency rather than an ambient singleton.
Long-lived runtime and background components — `launchDbos`/`shutdownDbos`
(`src/runtime/dbos.ts`), the graceful-shutdown sequence (`src/runtime/shutdown.ts`),
the connection-budget guard (`src/runtime/connection-budget.ts`), and the
DBOS-scheduled sandbox sweeps (`src/sandbox/watchdog.ts`, `reaper.ts`,
`notification-sweep.ts`) — accept a `pino.Logger` (or a narrowed
`Pick<pino.Logger, "info" | "warn" | "error">`) constructed at the composition
root and passed in. The harness never instantiates pino in production code; tests
supply a silent pino. This is the dependency-injection discipline the rest of the
harness follows: construction-time deps are injected, not reached for.

pino calls are **object-first**: `logger.info(fields, message)`, where `fields`
carry the run-context identifiers and `message` carries a `[module]` tag (e.g.
`[sandbox-watchdog]`, `[boot]`). Best-effort, non-fatal failures on hot tool /
execution / workflow paths use `console.warn` / `console.error` / `console.debug`
with the same `[module]`-tagged convention, embedding the relevant identifiers
(`runId`, `stepId`, `analysisId`, `execId`, `sandboxId`, `agentId`) inline.

There is **no `requestContext` object and no `[resourceId=]` / `[userId=]`
bracketed-prefix mechanism** — those never existed in this codebase. Run context
is carried by the concrete identifiers above, which originate in the
`RunSession`'s `RunFrame` (`runId`, `stepId`) and `Scope` (`analysisId`), not by
a generic context prefix. Distributed tracing and metrics are a separate concern
handled by OpenTelemetry (`src/lib/otel.ts`), not by the log line format.

## Requirements

### Requirement: Operational logging is pino-based and injected

Long-lived runtime and background components SHALL log through a pino logger
received as a constructor/parameter dependency, not a module-level singleton, and
the harness SHALL NOT instantiate pino in production code. Components that log
only best-effort progress MAY accept a narrowed
`Pick<pino.Logger, "info" | "warn" | "error">`.

#### Scenario: A runtime component logs through its injected logger

- **GIVEN** `launchDbos` is called with a `pino.Logger`
- **WHEN** it reports progress
- **THEN** it writes through the injected logger rather than constructing one

#### Scenario: A background sweep takes an optional narrowed logger

- **GIVEN** the sandbox watchdog runs with no logger supplied
- **WHEN** it completes a shard check
- **THEN** it does not fail for the absence of a logger and emits nothing through one

### Requirement: Structured logs carry run-context identifiers, not a context prefix

Log statements SHALL carry run context as concrete identifiers — drawn from the
`RunSession`'s `RunFrame` and `Scope` where available (`runId`, `stepId`,
`analysisId`) and from execution state (`execId`, `sandboxId`, `agentId`) — as
pino structured fields or inline in the message. The harness SHALL NOT use a
`requestContext` object and SHALL NOT prefix log lines with `[resourceId=...]` or
`[userId=...]`.

#### Scenario: A workflow-path log names the run and step

- **GIVEN** a sandbox step fails
- **WHEN** the failure is logged
- **THEN** the line identifies the failing `runId`/`stepId` directly, with no `requestContext` / `[resourceId=]` / `[userId=]` prefix

#### Scenario: No request-context machinery exists

- **WHEN** the source is searched for `requestContext`, `[resourceId=]`, or `[userId=]`
- **THEN** none are found — run context is carried by concrete identifiers only

### Requirement: Best-effort failures log via tagged console statements

Non-fatal, best-effort failures on tool / execution / workflow paths SHALL be
reported via `console.warn` / `console.error` / `console.debug` carrying a
`[module]` tag and the relevant identifiers, without aborting the surrounding
operation.

#### Scenario: A non-fatal indexing failure is warned and swallowed

- **GIVEN** post-step vector indexing fails for a step
- **WHEN** the failure is handled
- **THEN** a `[module]`-tagged `console.warn` records the `stepId` and the step pipeline continues
