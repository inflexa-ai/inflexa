## Why

The CLI currently has no structured logging — the TUI runs in alternate-screen mode and owns stdout/stderr, so there is nowhere to look when something goes wrong at runtime, and no way to observe how the tool behaves on real machines. We want Pino-based structured logs written to a local file, and an opt-in path to ship telemetry to our own servers over OTLP (OpenTelemetry), before more agent functionality lands and debugging without logs becomes painful.

## What Changes

- Add Pino as the project logger: a single root logger writing structured NDJSON to a log file under the existing XDG data directory (`<data>/inf/logs/`), never to stdout/stderr. Child loggers per module.
- Rotate logs: one file per day, 7-day retention, 20MB per-file cap (enforced at startup — the CLI is short-lived).
- Add PII redaction at the logger root (file paths, prompts/message text) so nothing sensitive leaves the machine even when export is enabled.
- Tap the event bus (`src/lib/bus.ts`) and log all `inf` events as structured records — these double as product telemetry events.
- Add OpenTelemetry log export: an explicit `initOtel()` / `shutdownOtel()` module (patterned after cortex `harness/lib/otel.ts`) that bridges Pino records into the OTel Logs SDK and exports them over OTLP/HTTP, gated on **both** user consent and a configured endpoint (`OTEL_EXPORTER_OTLP_ENDPOINT`). Logs-only for now; traces/metrics deferred until there is a real need.
- Add telemetry consent: opt-in, stored in a user config file, managed via a general `inf config` command that opens an interactive OpenTUI settings form (checkbox per setting, telemetry shown with its collection disclosure; toggles persist immediately). No consent → nothing is ever exported.
- Centralize environment access: all `process.env` reads live in `src/lib/env.ts`, enforced by an ESLint rule and a CLAUDE.md convention.
- Wire flush-on-exit: the CLI is short-lived, so batched log records are explicitly flushed on shutdown; telemetry failures are always non-fatal (fail open).

## Capabilities

### New Capabilities

- `structured-logging`: Pino root logger and child loggers, file destination under the data dir, log levels via environment, PII redaction, bus-event logging.
- `telemetry-export`: OTel Logs SDK initialization/shutdown, Pino→OTel bridge, OTLP/HTTP export gated on consent + endpoint, consent storage and the `inf telemetry` CLI command, flush-on-exit, fail-open behavior.

### Modified Capabilities

(none — the event bus is consumed by a new subscriber, but its requirements do not change)

## Impact

- New dependencies: `pino`; `@opentelemetry/api`, `@opentelemetry/api-logs`, `@opentelemetry/sdk-logs`, `@opentelemetry/exporter-logs-otlp-http`, `@opentelemetry/resources`, `@opentelemetry/semantic-conventions`.
- New files: `src/lib/log.ts` (logger + rotation), `src/lib/otel.ts` (OTel init/shutdown + bridge), `src/lib/config.ts` (user config / consent), `src/cli/config.tsx` (interactive settings form).
- Modified files: `src/lib/env.ts` (log dir, config path, env var reads), `src/lib/bus.ts` (bus-event logging tap), `src/index.ts` (init/shutdown wiring), `src/cli/index.ts` (register `config` command), `src/tui/app.tsx` (exit path flushes logs/telemetry), `eslint.config.js` + `CLAUDE.md` (no raw `process.env` outside env.ts).
- Runtime constraint: Bun — avoid Pino worker-thread transports and OTel module-patching instrumentation; use plain streams and explicit init (settled in design).
