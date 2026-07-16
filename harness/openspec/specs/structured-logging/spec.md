# structured-logging Specification

## Purpose

The harness logs operationally through an injected `Logger` (`src/lib/logger.ts`) and names no
logging library: it is published as `@inflexa-ai/harness` and must not push one onto its
consumers. The interface is message-first — `error(msg, fields?)`, the order `slog`, winston, and
`console` share — with `with(fields)` binding contextual fields, `named(name)` binding the
module namespace it renders as a `[a.b]` message prefix, and `errorFields(err)` normalizing a
thrown value. `errorFields` sits on the interface, not in the package, because the best shape for
an error belongs to the sink: a pino-backed realization defers to pino's `err` serializer, an
OTel-backed one to the `exception.*` semantic conventions. `defaultErrorFields` is the shipped
mapping for a realization with no opinion, and `createConsoleLogger` / `createNoopLogger` are the
shipped realizations.

`bootHarness` requires a `Logger` — an embedder that boots the harness has one place to decide
where diagnostics go, and that decision should be conscious. Every module deps bag below it takes
it optionally and falls back to `createNoopLogger()`, so internal call sites log unconditionally
rather than threading `?.` through every diagnostic; the fallback is never `console`.
`harness/src` calls `console` nowhere outside `lib/console-logger.ts` (enforced by `no-console` in
`eslint.config.js`, exempted by path): a host whose UI owns stdout discards console output, so the
write succeeds and the record is gone — silent loss exactly when something has failed.

Run context rides as structured fields (`runId`, `stepId`, `analysisId`, `execId`, `sandboxId`,
`agentId`) drawn from the `RunSession`'s `RunFrame` and `Scope`, never interpolated into the
message and never carried by a `requestContext` object or a `[resourceId=]` / `[userId=]`
prefix — those never existed here. Distributed tracing and metrics are a separate concern
handled by OpenTelemetry (`src/lib/otel.ts`), not by the log line format.

## Requirements
### Requirement: Structured logs carry run-context identifiers, not a context prefix

Log statements SHALL carry run context as concrete identifiers — drawn from the
`RunSession`'s `RunFrame` and `Scope` where available (`runId`, `stepId`,
`analysisId`) and from execution state (`execId`, `sandboxId`, `agentId`) — passed
as structured `LogFields` on the log call or bound via `with(...)`. Identifiers
SHALL NOT be interpolated into the message string, so that records stay
queryable and any redaction the host configures over field names applies. Each
record SHALL carry a module namespace, bound via `named(...)` per "A record's
namespace is bound at the seam, not typed into the message". The harness SHALL
NOT use a `requestContext` object and SHALL NOT prefix log lines with
`[resourceId=...]` or `[userId=...]`.

#### Scenario: A workflow-path log names the run and step

- **GIVEN** a sandbox step fails
- **WHEN** the failure is logged
- **THEN** the record carries the failing `runId`/`stepId` as structured fields, with no `requestContext` / `[resourceId=]` / `[userId=]` prefix

#### Scenario: Identifiers ride as fields, not interpolated text

- **GIVEN** a step failure carrying an error and a `runId`
- **WHEN** it is logged
- **THEN** the identifiers and the error appear as fields rather than being concatenated into the message string

#### Scenario: No request-context machinery exists

- **WHEN** the source is searched for `requestContext`, `[resourceId=]`, or `[userId=]`
- **THEN** none are found — run context is carried by concrete identifiers only

### Requirement: Operational logging goes through an injected host-agnostic Logger

The harness SHALL define its own `Logger` interface and SHALL NOT depend on a
concrete logging library — neither at runtime nor in its exported type surface.
The interface SHALL expose `debug`/`info`/`warn`/`error` taking the message
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

### Requirement: A record's namespace is bound at the seam, not typed into the message

A `Logger` SHALL expose `named(name)`, returning a logger that prefixes every
subsequent message with the namespace in brackets — `named("boot")` renders
`info("harness booted")` as `[boot] harness booted`. Nested `named` calls SHALL
compose with a dot separator (`[post-step.reconcile]`).

Modules SHALL bind their namespace through `named(...)` rather than hand-typing
a `[module]` tag into each message string, so the tag cannot drift in spelling
or be omitted, and a sink can recover the namespace without parsing prose.

#### Scenario: A module binds its namespace once

- **GIVEN** a component that binds `logger.named("sandbox-watchdog")`
- **WHEN** it logs `info("shard check completed", summary)`
- **THEN** the emitted message reads `[sandbox-watchdog] shard check completed` and the summary rides as fields

#### Scenario: Nested namespaces compose with a dot

- **GIVEN** a logger derived via `named("post-step").named("reconcile")`
- **WHEN** it logs `warn("dropping phantom")`
- **THEN** the emitted message reads `[post-step.reconcile] dropping phantom`

#### Scenario: An unnamed logger leaves the message untouched

- **GIVEN** a `Logger` with no namespace bound
- **WHEN** it logs `info("bare")`
- **THEN** the emitted message is exactly `bare`

### Requirement: Error normalization is the realization's to define

A `Logger` SHALL expose `errorFields(err: unknown): LogFields`, normalizing a
thrown value into fields a caller spreads onto a record. Call sites SHALL use it
rather than hand-rolling `err instanceof Error ? err.message : String(err)`, so
the mapping cannot drift between sites or silently drop a stack.

It SHALL sit on the interface rather than be a fixed harness-owned function,
because the best representation of an error is a property of the sink: a
pino-backed realization may defer to pino's `err` serializer, an OTel-backed one
to the `exception.*` semantic conventions. The harness SHALL export
`defaultErrorFields` as the shipped mapping — `err` carrying the message, `stack`
its own field — which a realization with no opinion references directly.

A raw `Error` SHALL NOT be passed through as a field value: it satisfies
`unknown` and type-checks, but `JSON.stringify(new Error())` is `{}`, so a
JSON-serializing sink would silently drop the message — the exact failure this
capability exists to prevent.

#### Scenario: The shipped mapping survives a JSON sink

- **GIVEN** a record whose fields come from `defaultErrorFields(new Error("boom"))`
- **WHEN** the sink serializes it to JSON
- **THEN** the message `boom` is still present, unlike a raw `Error` field which serializes to `{}`

#### Scenario: A realization substitutes its sink's error shape

- **GIVEN** a realization whose `errorFields` maps onto its sink's native error representation
- **WHEN** a harness call site logs a caught error through it
- **THEN** the record carries that realization's shape, not the shipped mapping

### Requirement: The harness ships console and no-op Logger realizations

The harness SHALL export `createConsoleLogger()` and `createNoopLogger()` from
its public entry point: the former so a consumer with no logging infrastructure
gets working diagnostics in one line, the latter as the fallback for an omitted
`logger` and as the explicit choice for a consumer wanting silence. The console
realization SHALL be the only site in `harness/src` permitted to call `console`,
and SHALL be offered as an explicit choice, never wired as the default — a host
whose UI owns stdout would discard it, which is indistinguishable from the logs
being lost.

#### Scenario: A consumer wires the console realization

- **GIVEN** an npm consumer importing `createConsoleLogger` from `@inflexa-ai/harness`
- **WHEN** it passes the result as the `logger` dependency and the harness logs a warning
- **THEN** the record reaches `console.warn` with its message and fields

#### Scenario: The no-op realization absorbs the full interface

- **GIVEN** a logger from `createNoopLogger()`
- **WHEN** a caller chains `with(...)` and `named(...)` and then logs at any level
- **THEN** nothing is emitted and no call throws

### Requirement: Harness source is free of console statements

`harness/src` SHALL NOT call `console.*` for diagnostics. The prohibition SHALL
be enforced by a `no-console` lint rule configured in `harness/eslint.config.js`,
scoped to permit the console realization alone, rather than by per-site
suppressions or review discipline.

#### Scenario: A new console call fails lint

- **GIVEN** a source file under `harness/src` other than the console realization
- **WHEN** it adds a `console.warn` call and lint runs
- **THEN** lint fails

#### Scenario: The console realization is permitted

- **WHEN** lint runs over the `createConsoleLogger` source
- **THEN** it passes, because the rule's configuration exempts that file

