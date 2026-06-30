## Context

inf is a Bun-runtime TUI CLI (cac + @opentui/solid in alternate-screen mode). The TUI owns stdout/stderr, so terminal logging is off the table. There is an event bus (`src/lib/bus.ts`, EventEmitter emitting `StampedEvent` with `__infId`), an SQLite storage layer, and `src/lib/env.ts` already computes the platform-appropriate data directory (`<data>/inf/`). There is no logging today beyond pre-render `console.error` calls.

We want: (1) Pino structured logs to a local file, always on; (2) opt-in export of those logs to our own servers via OpenTelemetry (OTLP), patterned on the proven `initOtel()`/`shutdownOtel()` module in cortex (`harness/lib/otel.ts`).

Constraints that shape the design:

- **Bun runtime.** Pino's transport system (`pino.transport`) runs targets in `worker_threads` via thread-stream, which has a history of breakage under Bun. OTel's `instrumentation-pino` package relies on module patching (require/import-in-the-middle), which is also unreliable under Bun and depends on load order.
- **Short-lived process.** Batched exporters must be explicitly flushed on exit or the last batch is silently dropped.
- **End-user machines.** Telemetry is product telemetry, not infra observability: it must be opt-in, redacted, and absolutely non-fatal.

## Goals / Non-Goals

**Goals:**

- Structured NDJSON logs at `<data>/inf/logs/inf.log`, with per-module child loggers and env-controlled level.
- Bus events logged as structured records (these are the product-telemetry signal).
- PII redaction applied at the logger root, before any record reaches the file or the exporter.
- Opt-in OTLP log export to `OTEL_EXPORTER_OTLP_ENDPOINT`, with explicit init/shutdown, batch processing, and flush-on-exit.
- `inf config` settings command (list + `set telemetry on|off`); consent persisted in a user config file.
- 7-day log retention with a 20MB per-file cap.
- Zero impact on the TUI render path and zero fatal failures from telemetry.

**Non-Goals:**

- Traces and metrics. There are no spans in the codebase yet and no multi-service topology; we ship logs-only and structure `otel.ts` so traces/metrics can be added later (the cortex file shows the shape).
- Mid-session log rotation. Rotation/retention runs at startup (see D8); a single TUI session crossing midnight or 20MB does not rotate in-flight.
- A hosted collector or server-side ingestion (separate repo/work).
- Replacing the OpenTUI debug console (`consoleOptions` in `tui.tsx`) — it remains for interactive debugging.

## Decisions

### D1: Plain Pino destination, no worker-thread transports

Use `pino(options, pino.destination({ dest: <logfile>, mkdir: true, sync: false }))` — sonic-boom writing directly from the main process, no `pino.transport()`.

- *Alternative — `pino.transport({ target: "pino/file" })`*: spawns a worker thread via thread-stream; historically flaky under Bun and adds an IPC hop for no benefit at CLI log volumes. Rejected.
- Async sonic-boom buffering keeps file writes off the hot path; `logger.flush()` on exit covers the tail.

### D2: Custom Pino→OTel bridge stream, not `instrumentation-pino` or `pino-opentelemetry-transport`

When telemetry is enabled, the logger writes to `pino.multistream([fileDestination, otelBridgeStream])`. The bridge stream is a small object-mode writable that parses each NDJSON line and emits an OTel `LogRecord` via `@opentelemetry/api-logs` (`logs.getLogger("inf")`), mapping Pino numeric levels to OTel severity (10→TRACE, 20→DEBUG, 30→INFO, 40→WARN, 50→ERROR, 60→FATAL) and attaching remaining fields as attributes.

- *Alternative — `@opentelemetry/instrumentation-pino`*: needs module patching before first import; fragile under Bun and overkill since we control the single logger instance. Rejected.
- *Alternative — `pino-opentelemetry-transport`*: worker-thread transport (same Bun risk as D1) and runs its own OTel SDK detached from ours. Rejected.
- The bridge is ~40 lines we own, fully explicit, and trivially testable. It only exists in the stream list when consent + endpoint are present, so the disabled path costs nothing.

### D3: Explicit `initOtel()` / `shutdownOtel()` (cortex pattern), logs-only

`src/lib/otel.ts` exports `initOtel()` and `shutdownOtel()`, called explicitly from the entry point (no side-effect imports — bundlers tree-shake them). `initOtel()` is idempotent and only sets up the Logs SDK when **both** consent is granted **and** `OTEL_EXPORTER_OTLP_ENDPOINT` is set: `LoggerProvider` with a `Resource` (`service.name: "inf"`, `service.version` from package.json) and a `BatchLogRecordProcessor` wrapping `OTLPLogExporter` at `<endpoint>/v1/logs` (trailing slashes stripped, like cortex). `shutdownOtel()` flushes via `Promise.allSettled` and never throws.

### D4: Consent in a JSON config file, not SQLite

Consent lives in `<config>/inf/config.json` (`XDG_CONFIG_HOME` / `~/.config`; `APPDATA` on Windows), shape `{ "telemetry": boolean }`, absent file = `false` (opt-in default). Read/written by `src/lib/config.ts` with `neverthrow` Results, matching house style.

- *Alternative — SQLite (`primary-storage`)*: couples telemetry init to DB availability and migrations, and the DB is session data, not settings. A config file is readable before anything else initializes and is user-editable. Rejected SQLite.
- `src/lib/env.ts` grows `logDir` and `configPath` alongside `dbPath`.
- Settings are managed via a general `inf config` command rather than a per-feature `inf telemetry` command. `inf config` opens an interactive OpenTUI form: one checkbox row per setting with its description inline (telemetry's row carries the collection disclosure and endpoint status). Edits are draft-first: space/enter toggles the draft (row marked `*`, header shows "unsaved changes"), `s`/Ctrl+S persists, and q/esc with a dirty draft warns once before a second press discards — the explicit save keypress is the confirmation, with no extra y/n dialog for an easily reversible boolean. Cmd+S is not bindable (macOS terminal emulators consume Cmd shortcuts before the PTY). cac is argv-only so it cannot render a form itself; OpenTUI is already a dependency, and a prompt library (e.g. @clack/prompts) was rejected to avoid a new dependency. The hand-editable JSON file remains the scriptable path.

### D5: Redaction at the logger root

Pino `redact` with censor `"[REDACTED]"` on known-sensitive paths (e.g. `*.text`, `*.prompt`, `err.config`, absolute-path-bearing fields), plus a serializer discipline: bus-event logging strips message/part text and logs only IDs, types, and lengths. Redaction lives on the root logger so it applies to the file **and** the export identically — what's on disk is what could be exported, making local inspection an honest preview of what leaves the machine.

### D6: Bus tap as the telemetry event source

`src/lib/bus.ts` exports `initBusLogging()`, which subscribes once to `Bus.on("inf", …)` and logs each event at `info` with `{ event: type, __infId, sessionId, … }` minus content fields (per D5). The subscription stays an explicit init call (not an import side effect) so importing `Bus` alone never starts the tap. No call-site changes anywhere events are emitted — the bus is already the spine.

### D7: Lifecycle wiring

`src/index.ts` becomes: create logger → read consent → `initOtel()` → register bridge stream if enabled → `cli.parse()`. Shutdown: a single `shutdown()` helper (flush logger, `await shutdownOtel()` with a ~2s timeout) called from the TUI exit path (the app controls exit since `exitOnCtrlC: false`) and from `process.on("exit")` as a best-effort sync flush. Telemetry/export errors are logged to the file at `debug` and swallowed.

### D7b: TUI exit paths destroy the renderer before exiting

OpenTUI registers its terminal restore (disable mouse tracking, leave alternate screen, cooked mode) on `process.on("beforeExit")`, which never fires on explicit `process.exit()` — so any exit through `shutdown()` must call `useRenderer().destroy()` first or the shell is left receiving mouse escape sequences. Both the config form and the TUI `/quit` path do this. Related rendering gotcha: OpenTUI boxes default to column flex direction, so header rows of sibling `<text>` elements need explicit `flexDirection="row"` or they overdraw each other.

### D8: Startup-time log rotation (daily files, 7-day retention, 20MB cap)

The logger writes to a dated file (`inf-<YYYY-MM-DD>.log`). At logger init: files matching the log pattern older than 7 days are deleted, and if today's file already exceeds 20MB the destination rolls to the next numbered suffix (`inf-<date>.2.log`, …). Rotation is best-effort — any scan/delete failure falls through to plain logging.

- *Alternative — `pino-roll` transport*: worker-thread transport, excluded under Bun (same reason as D1). Rejected.
- *Alternative — in-flight rotation (size counter in the stream)*: solves the long-session edge case but adds machinery for a case that redacted, length-only records rarely hit; revisit if real logs prove otherwise. Deferred.
- The CLI being short-lived makes startup the natural rotation point: every invocation sweeps retention.

### D9: All environment reads centralized in `env.ts`

`process.env` is read only in `src/lib/env.ts`; consumers import the frozen `env` object (`logLevel`, `otelEndpoint`, paths). Validation stays with the consumer (`env.ts` shouldn't import pino to know valid levels). Enforced two ways: an ESLint `no-restricted-properties` rule on `process.env` (exempting `env.ts`) and a CLAUDE.md convention note.

## Risks / Trade-offs

- [Bun + sonic-boom edge cases] → sonic-boom is plain `fs.write`-based and widely used under Bun; smoke-test in task list (`bun run dev`, verify file output) before building on it.
- [Custom bridge drifts from OTel severity/attribute conventions] → mapping is a single table with unit-ish coverage; conventions for severity numbers are stable.
- [Dropped tail logs on hard kill (SIGKILL/crash)] → accepted; `process.on("exit")` + explicit flush covers normal paths.
- [multistream minimum-level subtleties] → set explicit `level` per stream entry so the bridge sees the same records as the file.
- [Logs-only now, traces later could mean rework] → `otel.ts` mirrors cortex's structure (sections per signal, shared resource/endpoint parsing), so adding a `NodeTracerProvider` block later is additive.
- [Config file racing concurrent CLI instances] → last-writer-wins on a one-boolean file; acceptable.

## Open Questions

- Exact redact path list will grow with the schema; start with message/part text + working-dir fields and treat additions as routine.
- Whether `inf telemetry on` should print a one-time disclosure of what is collected (recommended: yes, short).
