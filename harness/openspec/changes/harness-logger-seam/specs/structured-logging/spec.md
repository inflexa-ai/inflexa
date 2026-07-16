## ADDED Requirements

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
object. An embedder MAY omit it; the harness SHALL then substitute a no-op
realization, so internal call sites log unconditionally rather than threading
optional chaining through every diagnostic. The harness SHALL NOT fall back to
`console`, which a host whose UI owns stdout would discard.

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

## MODIFIED Requirements

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

## REMOVED Requirements

### Requirement: Operational logging is pino-based and injected

**Reason**: The harness is published as `@inflexa-ai/harness`, so naming pino in
its contract dictates a logging library to every consumer and models the public
surface on one embedder's choice. The coupling was already only nominal — every
pino reference was a type-only import, so the harness had no runtime dependency
to shed. The injection discipline this requirement established is retained and
strengthened by "Operational logging goes through an injected host-agnostic
Logger"; only the pino-specific contract (and its object-first
`logger.info(fields, message)` call shape) is withdrawn.

**Migration**: Depend on the harness's `Logger` interface. An embedder using pino
supplies a small adapter at its composition root — flipping argument order to
message-first and mapping `with(fields)` onto pino's `child(bindings)` — and
passes it wherever `logger` is required. Consumers with no preference use the
exported `createConsoleLogger()`.

### Requirement: Best-effort failures log via tagged console statements

**Reason**: Console output is not readable in the hosts the harness actually runs
in. An embedder whose UI owns stdout discards every such line — the CLI's TUI
runs in alternate-screen mode and routes its logger to a file precisely because
stdout is unavailable — so this requirement mandated writing diagnostics to a
channel that is destroyed on arrival. It caused a real, repeated production step
failure to be reported with no diagnostic detail whatsoever. Neither fallback
recovers it: the harness scrubs internal detail before the error crosses any
boundary, and log-forwarding pipelines that sit downstream of the host's logger
never see a console call at all.

**Migration**: Report best-effort failures through the injected `Logger` at
`warn`/`error`/`debug`, keeping the `[module]` tag in the message and moving the
identifiers into structured fields. Non-fatal semantics are unchanged — the
surrounding operation still swallows the failure and continues; only the
destination changes.
