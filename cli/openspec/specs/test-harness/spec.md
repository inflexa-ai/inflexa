# test-harness Specification

## Purpose
TBD - created by archiving change add-test-suite. Update Purpose after archive.
## Requirements
### Requirement: Isolated environment preload
The test suite SHALL provide a `bun:test` preload (registered via `bunfig.toml` `[test] preload`)
that redirects `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, and `HOME` to a unique per-process temp directory
before any `src/lib/env.ts` import, so that the frozen `env.dbPath` and config path resolve inside
the temp directory and no test writes to the developer's real home.

#### Scenario: env resolves under the temp dir
- **WHEN** a test reads `env.dbPath` after the preload has run
- **THEN** the path is rooted under the per-process temp directory, not the real `XDG_DATA_HOME`

#### Scenario: no writes leak to the real home
- **WHEN** an integration test creates a DB and writes rows
- **THEN** the developer's real `~/.local/share/inflexa` (or platform equivalent) is left untouched

### Requirement: Migrated temp-DB helper
The harness SHALL provide a helper that yields a freshly-migrated SQLite database for a test and
resets the `db()` singleton (`_db`) between tests, and whose teardown removes the temp directory
including the `-wal` and `-shm` sidecar files.

#### Scenario: helper returns a migrated connection
- **WHEN** a test requests the temp DB
- **THEN** all migrations have run and the schema (tables, FKs) is present and queryable

#### Scenario: isolation between tests
- **WHEN** two tests each request the temp DB
- **THEN** rows written by the first test are not visible to the second

### Requirement: Solid createRoot test lifecycle
The harness SHALL provide a way to run reactive code (signals/stores) inside a `createRoot` scope
that is disposed after the test, and to reset the relevant process-global stores
(`theme`, `notice`, `status`, `conversation`, keymap layers/mode stack) between cases.

#### Scenario: store reset between cases
- **WHEN** one test mutates a global store and a later test reads it
- **THEN** the later test observes the default value, not the prior mutation

### Requirement: Headless render helper
The harness SHALL provide a helper that renders a component tree via `testRender` at a given
`{ width, height }`, returns the trimmed `captureCharFrame()` text, and always calls
`renderer.destroy()` even when the assertion throws.

#### Scenario: frame captured and renderer destroyed
- **WHEN** a component is rendered through the helper and the test body completes or throws
- **THEN** the helper returns the captured frame text AND the renderer is destroyed in a `finally`

### Requirement: CLI subprocess helper
The harness SHALL provide a helper that invokes the CLI via `Bun.spawnSync(["bun", "run",
"src/index.ts", ...args])` with `env` pinned to the temp directories, returning the exit code,
stdout, and stderr as strings.

#### Scenario: command observables captured
- **WHEN** the helper runs a CLI command
- **THEN** it returns `{ exitCode, stdout, stderr }` reflecting the real process result

