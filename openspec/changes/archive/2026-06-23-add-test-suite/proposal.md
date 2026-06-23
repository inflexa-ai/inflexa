## Why

The app has 3 test files (keymap, fuzzy, notice) and no CI gate, so almost all of the
CLI commands, the DB/anchor reconciliation layer, the chat engine, and the TUI stores ship
unverified. A regression in slug generation, marker write-once, token refresh, or the bus-event
reducer would land silently. We need a real automated suite with a defined quality bar before
the surface keeps growing.

## What Changes

- Add a **test harness layer**: a `bun:test` preload that points `XDG_DATA_HOME`/`XDG_CONFIG_HOME`
  at a per-run temp dir (so the frozen-at-import `env` gives integration tests an isolated DB),
  plus shared helpers for temp-DB setup, Solid `createRoot` lifecycle, `testRender` frame capture,
  and `Bun.spawnSync` CLI invocation.
- Add **unit tests** for pure logic across `lib/`, `extensions/`, `auth/`, `intelligence/`,
  `analysis/`, and the `design_system` data invariants.
- Add **integration tests** for the SQLite migration runner, query/mutation round-trips +
  `DbError` constraint classification, and marker/anchor reconciliation against temp dirs.
- Add **CLI e2e tests** that drive real commands via subprocess against a temp DB, asserting
  exit code + stdout + stderr + filesystem (auth/setup excluded — network/docker; cheap adjacent
  wins like `whoami`'s JWT decode are in scope as units).
- Add **TUI logic tests**: the `applyBusEvent` reducer, the theme/notice/status stores, keymap
  config-resolution, and `testRender`-based rendering of key components.
- Quality bar (enforced by review, documented in `TESTING-SYSTEM-REPORT.md`): assert state not
  interactions, mock only at the network boundary, never mock the DB on the happy path,
  deterministic snapshots only.

## Capabilities

### New Capabilities
- `test-harness`: shared test infrastructure — the bun:test preload (temp `XDG_*` → isolated DB),
  temp-DB setup/teardown helper, Solid `createRoot` test lifecycle, `testRender`/`captureCharFrame`
  helper, and the `Bun.spawnSync` CLI-invocation helper. Encodes the global-singleton reset rules.
- `unit-test-coverage`: unit tests for pure logic — `str256`, fuzzy scoring, the global extensions,
  auth error/token helpers, chat message-shaping + default-model pick, analysis boundary/slug/path
  helpers, config schema self-healing, and design-system cross-table invariants.
- `integration-test-coverage`: DB/filesystem tests against temp dirs — migration runner
  (schema/FK/idempotency), query+mutation round-trips with `DbError` classification, id-or-name
  resolvers, marker read/write/write-once, and anchor reconciliation (cached-hit/self-heal/
  bounded-search/ambiguity), plus config and input/output path resolution.
- `cli-e2e-coverage`: subprocess tests of real CLI commands (`ls`, `status`, `sessions`,
  `project new`/`ls`, `repair`, and the no-litter guarantee) asserting all four observables.
- `tui-test-coverage`: TUI logic + render tests — the `applyBusEvent` bus reducer, theme/notice/
  status stores, keymap config-resolution + remap, and `testRender` rendering of core components.

### Modified Capabilities
<!-- None. This change adds test coverage; it does not change any existing capability's requirements. -->

## Impact

- **New files only** under `src/**` (co-located `*.test.ts`/`*.test.tsx`) and a test preload
  (e.g. `test/preload.ts` referenced from `bunfig.toml [test] preload`).
- **`bunfig.toml`**: add a `[test]` section with the preload.
- A handful of currently module-private functions gain an `export` to be unit-testable directly
  (`decodeIdTokenClaims`, `toModelMessages`, `pickDefaultModel`, `makeBaseSlug`, `openerArgv`) —
  no behavior change.
- No new runtime dependencies (bun:test, opentui test utils, and bun:sqlite are already present).
- No production code paths change; CI wiring to run `bun test` is out of scope (local-run for now).
