## Why

The harness logs through two channels: an injected logger in `runtime/*`, and **63 direct `console.*` calls** everywhere else (workflows, execution, tasks, tools). Only the first is readable. An embedder whose UI owns stdout discards the rest — the CLI's TUI runs in alternate-screen mode, and its `lib/log.ts` states plainly that "the file is the only terminal-safe destination". Every `console.*` line the harness writes on a CLI run is thrown away.

This has a concrete cost. A customer hit a repeated `lineage_attestation` step failure; the log they sent contained zero diagnostic detail, because `sandbox-step.ts`'s `failStep` writes the error and stack to `console.error` and then throws a deliberately scrubbed message. The only copy of the cause is destroyed at the instant of failure, and diagnosing it required reconstructing the failure path from source. Neither fallback helps: logging at the harness boundary cannot recover it (the boundary only ever sees the scrubbed phrase, by design), and OpenTelemetry cannot either (the embedder's OTel is a *sink fed by pino*, sitting downstream of the very channel that is broken).

The console usage is not drift — the `structured-logging` spec **mandates** it ("Best-effort failures ... SHALL be reported via `console.warn` / `console.error` / `console.debug`"). So the requirement itself is what must change. The same spec also binds the harness's public surface to **pino**, which is wrong for a package published to npm: the harness should not tell its consumers which logger to own. That coupling is cheaper to remove than it looks — all nine pino references are `import type`, so the harness has zero runtime dependency on it today.

## What Changes

- Introduce a harness-owned `Logger` interface (`debug`/`info`/`warn`/`error`, plus `with()` for contextual fields, `named()` for the module namespace, and `errorFields()` to normalize a thrown value) with `createConsoleLogger()`, `createNoopLogger()`, and `defaultErrorFields()` exported from `index.ts`. The interface is **msg-first** (`error(msg, fields?)`), matching Go's `slog`, winston, and `console` — deliberately *not* pino's object-first shape, so the public surface is not modelled on one consumer's choice. `errorFields` sits on the interface so a realization can defer to its sink's native error handling (pino's `err` serializer, OTel's `exception.*`) rather than a harness-imposed shape.
- **BREAKING**: `BootHarnessDeps.logger` changes type from `pino.Logger` to `Logger`. An embedder passing pino raw no longer type-checks and must supply an adapter. In-repo this is one small adapter at the CLI's composition root.
- Replace hand-typed `[module]` message tags with `named(...)` bound at the seam, so the namespace cannot drift in spelling or be dropped, and the existing narrowed `logger?: Pick<pino.Logger, ...>` deps widen to `Logger`. An omitted `logger` falls back to the no-op realization, so internal call sites lose their `deps.logger?.` chaining — the fallback is never console, which a TUI host would discard.
- Remove `pino` from harness `dependencies`; replace the nine `import type pino` sites with `Logger`.
- Replace all 63 `console.*` sites in `harness/src` with logger calls carrying **structured fields** (`logger.error("...", { runId, stepId, errorClass, err })`) rather than interpolated strings, so records are queryable and inherit whatever redaction the host configures.
- Enforce with a `no-console` lint rule in `harness/eslint.config.js`, with `createConsoleLogger()` as the single sanctioned exception — the rule is the guardrail, not review.
- Fix `src/lib/otel.ts`'s `console.log` banner. It is currently the stated reason the CLI refuses the harness's telemetry entirely (`initTelemetry: () => {}`), which also silences the `cortex.artifact.reconcile.dropped` counter that is instrumented in the failing attestation path.

## Capabilities

### New Capabilities

None. Logging is already an owned capability (`structured-logging`); this changes its contract rather than adding one.

The `Logger` is deliberately **not** added to the five capability seams in `harness-durable-runtime`. That list exists to "isolate core from managed realizations" — hosted-service dependencies with cloud counterparts. A logger is an output channel, not a hosted service, and that spec's DI requirement already names "logger" among injected construction-time deps, so it needs no amendment.

### Modified Capabilities

- `structured-logging`: every requirement in the capability is touched. Two are **removed**: "Operational logging is pino-based and injected" (its name asserts the coupling being withdrawn, and its object-first call shape goes with it) and "Best-effort failures log via tagged console statements" (it mandates writing to a channel the host destroys). Three are **added** in their place: logging through an injected host-agnostic msg-first `Logger` as a required dep, a shipped `createConsoleLogger()` realization, and a lint-enforced ban on `console` in `harness/src`. One is **modified**: "Structured logs carry run-context identifiers, not a context prefix" keeps its intent — concrete `runId`/`stepId`/`analysisId` over a context prefix — but drops its pino-specific wording and now requires identifiers to ride as structured fields rather than being interpolated into the message.

## Impact

- **Public API (semver-major for `@inflexa-ai/harness`)**: `Logger`, `LogLevel`, `LogFields`, `createConsoleLogger` added to `index.ts`; `BootHarnessDeps.logger` retyped; required `logger` on exported deps interfaces. Consumers passing pino must add an adapter.
- **Dependencies**: `pino` leaves harness `dependencies` (type-only today, so no runtime change).
- **Harness code**: ~63 call sites across `workflows/`, `execution/`, `tasks/`, `tools/`, `sandbox/`, `lib/`, `state/`; nine `import type pino` sites; `eslint.config.js`.
- **CLI embedder**: a pino adapter at its composition root (flip arg order, map `with` → `child`); pass it into `bootHarness` and the deps bags. Harness logs then flow into the existing pino file destination **and** the existing `createOtelLogStream()` OTLP bridge with no further work.
- **Not in scope**: the underlying provenance defect that causes the attestation failures (inotify `IN_OPEN` recorded as a read, producing phantom inputs). This change makes failures observable; fixing the misclassification is a separate change that this one unblocks.
