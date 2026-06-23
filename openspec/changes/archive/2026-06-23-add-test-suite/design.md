## Context

The codebase has `bun test` configured and 3 passing test files (`keymap`, `fuzzy`, `notice`),
but no harness for the parts that touch the DB, the filesystem, or the network, and no CI gate.
`TESTING-SYSTEM-REPORT.md` (repo root) is the authoritative strategy doc — this design references
it rather than restating it. The binding constraint is that `src/lib/env.ts` `Object.freeze`s `env`
at import and `db()` caches a singleton `Database(env.dbPath)`, so test isolation must be arranged
*before first import*, not via a runtime setter.

## Goals / Non-Goals

**Goals:**
- A reusable test harness that gives integration tests an isolated, migrated SQLite DB and a clean
  temp HOME, with deterministic teardown.
- Coverage across the three tiers (unit / integration / e2e) for CLI commands, heavy logic, and core
  TUI functionality, meeting the quality bar in the report (state-not-interactions, mock only at the
  network boundary).
- Tests that survive refactors: they assert observable behavior and persisted state, not call shapes.

**Non-Goals:**
- CI wiring (running `bun test` in GitHub Actions) — local-run for now.
- Coverage of `auth login`/`logout` and `setup` end-to-end (network + docker/podman) — only their
  pure, network-free fragments (JWT decode, config builders, poll-loop with a stubbed `fetch`).
- 100% line coverage or per-component snapshot tests for every TUI widget — value-ranked targets only.
- Refactoring production code beyond adding `export` to a few pure helpers.

## Decisions

**1. Isolate via a bun:test preload that sets `XDG_*` to a temp dir — not a DB path setter.**
The report establishes `env` is frozen at import and `dataDir()` honors `XDG_DATA_HOME`. A preload
(`bunfig.toml` `[test] preload`) sets `XDG_DATA_HOME`/`XDG_CONFIG_HOME`/`HOME` to a per-process temp
dir before any `db/` import. *Alternative considered:* add a `:memory:`/path option to `db()` —
rejected: changes production code for a test-only need, and `:memory:` can't be shared across the
query/mutation fns that each call the singleton. The direct `runMigrations(new Database(":memory:"),
migrations)` path is still used for pure migration-runner tests where no env plumbing is wanted.

**2. Co-locate tests as `*.test.ts(x)` beside source.** Matches the 3 existing test files and the
`@/*` path + `jsxImportSource` tsconfig. *Alternative:* a separate `test/` mirror dir (opencode's
choice) — rejected for this smaller codebase; co-location keeps the test beside the unit it pins.

**3. Tier-appropriate seams.** Pure fns → import-and-assert. Solid stores/reducers → run inside
`createRoot` and assert the store value (no TTY). TUI rendering → `testRender` + `captureCharFrame`,
swept across heights, `renderer.destroy()` in `finally`. CLI → `Bun.spawnSync(["bun","run",
"src/index.ts",…])` with env pinned to the temp dirs. *Alternative for CLI:* in-process commander
dispatch — kept as a secondary option but e2e via subprocess is the high-fidelity default and dodges
stdout-interception issues.

**4. `Bun.spawnSync`, not async `Bun.spawn` + `stdout:"pipe"`, inside `bun test`.** The report cites
an open Bun bug (piped output empty under the runner). `spawnSync` returns Buffers + `exitCode` +
`success` reliably.

**5. Real DB on the happy path; mock only the network.** Per the qualitative bar: read rows back to
verify writes; stub `fetch`/`Promise.sleep` only for Auth0 device-flow and proxy HTTP.

**6. Reset process-global state between cases.** keymap layers/modeStack, `theme.ts` activeThemeId,
`status.ts`, `notice.ts` (current+timer), `conversation.ts` store/signals, and the `db()` `_db`
cache are module singletons. Harness helpers expose reset hooks; `createRoot` disposal covers the
Solid scopes. The two `.unref()`'d auto-dismiss timers already avoid hanging the runner.

**7. Deterministic snapshots only.** Scrub `randomUUIDv7()` ids + timestamps to fixed tokens, strip
ANSI, normalize paths — in one shared normalizer. Snapshots are reviewed, never blind-`-u`'d.

## Risks / Trade-offs

- **[Preload ordering fragility]** If a test imports `db/` before the preload runs, it opens the real
  DB. → Mitigation: the `[test] preload` runs before any test module loads; assert in a harness
  self-test that `env.dbPath` resolves under the temp dir.
- **[Module-private helpers]** Some targets need an `export`. → Mitigation: add named exports (no
  behavior change); document each in the task as "export-only".
- **[opentui teardown segfaults]** The report notes opentui can segfault Bun on certain render
  teardowns. → Mitigation: always `destroy()` in `finally`; if a specific transition segfaults,
  `test.skip` it with a comment, as opencode does.
- **[Singleton bleed]** A forgotten reset makes tests order-dependent. → Mitigation: centralize resets
  in `beforeEach`/`afterEach` harness helpers; prefer `createRoot` scopes that auto-dispose.
- **[`bun:sqlite` WAL files on teardown]** temp DB leaves `-wal`/`-shm`. → Mitigation: teardown
  removes the whole temp dir (not just the `.db` file).
