## 1. Dependencies & paths

- [x] 1.1 Add deps: `pino`, `@opentelemetry/api`, `@opentelemetry/api-logs`, `@opentelemetry/sdk-logs`, `@opentelemetry/exporter-logs-otlp-http`, `@opentelemetry/resources`, `@opentelemetry/semantic-conventions` (bun add)
- [x] 1.2 Extend `src/lib/env.ts` with `logDir` (`<data>/inf/logs`) and `configPath` (`XDG_CONFIG_HOME`/`APPDATA` → `inf/config.json`)

## 2. Structured logging (Pino)

- [x] 2.1 Create `src/lib/log.ts`: root logger with `pino.destination({ mkdir: true, sync: false })` to `<logDir>/inf.log`, level from `INF_LOG_LEVEL` (default `info`, fall back on invalid), redact config with `[REDACTED]` censor, and a `getLogger(module)` child-logger helper
- [x] 2.2 Smoke-test under Bun: `bun run dev`, confirm NDJSON lines land in the file, nothing hits the terminal, directory auto-creates on a clean machine (delete `<data>/inf/logs` first)
- [x] 2.3 Add bus tap (in `src/lib/log.ts` or `src/lib/bus-logging.ts`): single `Bus.on("inf", …)` subscriber logging event type, `__infId`, entity IDs, and content lengths — never content fields; verify a `part.delta` record contains delta length but not delta text

## 3. Consent config & CLI command

- [x] 3.1 Create `src/lib/config.ts`: read/write `{ telemetry: boolean }` at `env.configPath` returning `neverthrow` Results; missing or invalid file reads as `{ telemetry: false }`
- [x] 3.2 Create `src/cli/telemetry.ts` and register `inf telemetry <on|off|status>` in `src/cli/index.ts` (lazy import, matching existing command style); `on` prints a short collection disclosure, `status` prints consent + whether `OTEL_EXPORTER_OTLP_ENDPOINT` is set

## 4. OTel export

- [x] 4.1 Create `src/lib/otel.ts` mirroring cortex `harness/lib/otel.ts` structure: idempotent `initOtel(consented: boolean)` that, when consented AND `OTEL_EXPORTER_OTLP_ENDPOINT` is set, builds `LoggerProvider` with resource (`service.name: "inf"`, version from package.json) + `BatchLogRecordProcessor` + `OTLPLogExporter` at `<endpoint>/v1/logs` (strip trailing slashes); `shutdownOtel()` flushes via `Promise.allSettled` with ~2s timeout, never throws
- [x] 4.2 Implement the Pino→OTel bridge stream in `src/lib/otel.ts` (or `otel-bridge.ts`): writable that parses NDJSON records and emits via `logs.getLogger("inf")` with level→severity table (10→TRACE … 60→FATAL), `msg` as body, remaining fields as attributes; wire `pino.multistream` in `log.ts` to include it only when telemetry is active, with explicit per-stream `level`
- [x] 4.3 Make export failures non-fatal: exporter/bridge errors swallowed, at most `debug`-logged to file; verify TUI runs normally with telemetry on and an unreachable endpoint

## 5. Lifecycle wiring

- [x] 5.1 Wire `src/index.ts`: create logger → read consent → `initOtel()` → `cli.parse()`; add a `shutdown()` helper (flush logger + `await shutdownOtel()`) called from the TUI exit path in `src/cli/tui.tsx`/`src/tui/app.tsx` and best-effort on `process.on("exit")`
- [x] 5.2 End-to-end check with a local OTLP sink (e.g. `docker run otel/opentelemetry-collector` with logging exporter, or any OTLP echo): `inf telemetry on` + endpoint set → records arrive including the final pre-exit batch; redacted fields arrive as `[REDACTED]`

## 6. Quality gates (initial implementation)

- [x] 6.1 `bun run typecheck` and `bun run lint` clean; `bun run format:file` on all touched `src/` files
- [x] 6.2 Verify spec scenarios pass manually: default-off (no config file → no network), corrupt config fails closed, `initOtel()` idempotent, `INF_LOG_LEVEL=debug` enables debug records

## 7. Refinements (post-review)

- [x] 7.1 Centralize env reads: add `logLevel` and `otelEndpoint` to `src/lib/env.ts`; consume them in `log.ts`/`otel.ts`; add ESLint `no-restricted-properties` rule on `process.env` (exempting `env.ts`) and a CLAUDE.md convention note
- [x] 7.2 Log rotation in `src/lib/log.ts`: dated filename, startup deletion of files older than 7 days, roll to numbered suffix at ≥20MB; verify with seeded old/oversized files
- [x] 7.3 Move the bus tap from `src/lib/bus-logging.ts` into `src/lib/bus.ts` (still explicit `initBusLogging()`), delete the old file, update imports
- [x] 7.4 Replace `inf telemetry` with interactive `inf config` (OpenTUI form in `src/cli/config.tsx`): checkbox rows, telemetry disclosure + endpoint status, space/enter toggles persist immediately, q/esc exits via `shutdown(0)`; delete `src/cli/telemetry.ts`
- [x] 7.5 Re-run quality gates (typecheck, lint with new rule, format touched files) and re-verify consent gating end-to-end
- [x] 7.6 Fix TUI teardown and header rendering: call `useRenderer().destroy()` before `shutdown()` on both exit paths (OpenTUI's terminal restore hangs off `beforeExit`, which `process.exit` skips — mouse tracking leaked into the shell); add `flexDirection="row"` to header boxes (boxes default to column, siblings overdrew each other); verified via PTY capture (all modes set/reset) and headless `testRender`
- [x] 7.7 Draft-first config form: toggling updates a draft (`*` marker + "unsaved changes" header), `s`/Ctrl+S saves, q/Esc with dirty draft warns once then discards on second press; verified headlessly with scripted mock keys and via PTY (discard path leaves config untouched)
