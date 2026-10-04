# test-harness Specification

## Purpose
The shared test support of the CLI suite, which keeps each test away from the real data of the user. A preload puts each test into a sandbox, and `src/lib/env.ts` refuses each path outside the sandbox. Helpers give a migrated temporary database, a reactive root, a headless render, a CLI subprocess, and a test server.

## Requirements

### Requirement: The test sandbox is enforced structurally, not by convention

`src/lib/env.ts` — the sole reader of `process.env` — SHALL refuse to resolve any XDG-derived path when
the process is running under `bun test` (`NODE_ENV === "test"`) and the sandbox marker
`INFLEXA_TEST_SANDBOX` is absent. The refusal SHALL be a throw at module import, before any path is
computed, naming the remedy (run `bun test` from `cli/`).

This closes the residual data-loss hole that per-site checks cannot: `bun` resolves `bunfig.toml` from
the working directory only and does not walk up, so `bun test` invoked from any nested directory (an
IDE "run test at cursor" runner sets the cwd to the test file's directory) applies neither `cli/`'s
sandbox preload nor the repository root's refusal preload. In that state every `env.*` path resolves to
the developer's real `~/.local/share/inflexa` and `~/.config/inflexa`.

The guard SHALL be inert outside `bun test`:

- a compiled binary, whose `NODE_ENV` is `--define`d to the build channel, folds the comparison away;
- `bun run dev`, where `NODE_ENV` is unset;
- the CLI subprocess helper, which inherits both `NODE_ENV` and the marker from its sandboxed parent.

`assertTestSandbox(path)` SHALL remain the per-site authorization for an individual destructive path,
and SHALL compare on a path boundary (the sandbox root followed by a separator) rather than a bare
string prefix, so a sandbox root cannot authorize a write to a sibling directory sharing its prefix. Its
documentation SHALL NOT claim to be a choke point every destructive site funnels through — only
`resetDb` calls it internally; every other site opts in by hand, which is the failure mode this
requirement's `env.ts` guard exists to backstop.

#### Scenario: A test run from a nested directory refuses to start

- **WHEN** `bun test` is invoked with a working directory that contains no `bunfig.toml`, so the sandbox preload never runs
- **THEN** importing `src/lib/env.ts` SHALL throw before any path resolves
- **AND** no file under the developer's real data or config directory SHALL be read, written, or deleted

#### Scenario: A sandboxed test run proceeds

- **WHEN** `bun test` runs from `cli/`, whose preload redirects `XDG_*` and stamps `INFLEXA_TEST_SANDBOX`
- **THEN** `env.ts` imports normally and every `env.*` path resolves under the sandbox root

#### Scenario: The compiled binary is unaffected

- **WHEN** a binary built by `scripts/build.ts` runs on a user's machine
- **THEN** the guard SHALL NOT throw, because `NODE_ENV` is a baked literal equal to the build channel

#### Scenario: A prefix-sharing sibling directory is not authorized

- **WHEN** `assertTestSandbox` is called with a path under `<sandbox>DEF` while the marker names `<sandbox>`
- **THEN** it SHALL throw

### Requirement: Isolated environment preload

A `bun:test` preload registered by `cli/bunfig.toml` SHALL redirect `XDG_DATA_HOME` and
`XDG_CONFIG_HOME` into a fresh `mkdtemp` sandbox before any test module — and therefore before the
first import of `src/lib/env.ts`, which freezes its XDG-derived paths at import — and SHALL stamp
`INFLEXA_TEST_SANDBOX` with the sandbox root. An exit hook SHALL reap the sandbox.

The repository root SHALL carry a `bunfig.toml` whose `[test].preload` aborts the process before any
test body runs, because `bun test` from the root does not apply `cli/bunfig.toml`'s preload and would
therefore execute cli tests against the developer's real home. The abort SHALL use `process.exit`, not
a throw: a throwing preload is not a reliable abort across bun versions, whereas a hard exit is.

Diagnostics for that abort SHALL name only directories that actually establish a sandbox. `harness/`
has no `bunfig.toml` and no test preload; its suite is safe because no harness test touches an XDG path,
not because a sandbox is established for it.

#### Scenario: env resolves under the temp dir
- **WHEN** a test reads `env.dbPath` after the preload has run
- **THEN** the path is rooted under the per-process temp directory, not the real `XDG_DATA_HOME`

#### Scenario: no writes leak to the real home
- **WHEN** an integration test creates a DB and writes rows
- **THEN** the developer's real `~/.local/share/inflexa` (or platform equivalent) is left untouched

#### Scenario: Root test invocation aborts before any test body

- **WHEN** `bun test` is invoked from the repository root, with or without an explicit test-file path
- **THEN** the process SHALL exit non-zero before executing any test
- **AND** the message SHALL direct the user to run from the owning subsystem's directory

#### Scenario: The root config does not leak into a subsystem run

- **WHEN** `bun test` is invoked from `cli/`
- **THEN** `cli/bunfig.toml` SHALL apply and the root refusal preload SHALL NOT run

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

### Requirement: A test never starts a real local server

The test preload SHALL set `INFLEXA_SERVER_FILE` to a discovery file inside the test sandbox. Under that variable a client only connects to the server that the file names, and never starts one in the background. Thus an instance command that a test runs with no test server SHALL fail at its server check, and SHALL NOT spawn a server that binds the dev port and boots the containers.

#### Scenario: An instance command with no test server fails fast

- **WHEN** a test runs an instance command as a subprocess and no test server answers
- **THEN** the command exits non-zero with the instruction to start a server, and no server process starts

### Requirement: Test server helper

The harness SHALL provide a helper that starts the HTTP app of the local server inside the test process, for an end-to-end test of an instance command. It SHALL bind `127.0.0.1` on a port that the OS picks, write a new discovery file with a new token into a new folder inside the test sandbox, and give the env that a child needs to find it (`INFLEXA_SERVER_FILE`). Thus two test servers never share a port or a discovery file, and a test server never touches the dev port or the dev discovery file.

By default the server SHALL use a boot that never starts: a route that needs the harness runtime answers 503 `unavailable`, and each route that reads or writes SQLite works. A test can pass its own boot for a route that needs the runtime. The routes SHALL read and write the sandboxed SQLite database of the test process, thus a test seeds and asserts through the database layer as before. The helper SHALL stop the listener and remove the folder of the discovery file at its stop.

#### Scenario: A child command reaches the test server

- **GIVEN** a test server and a seeded project in the sandboxed database
- **WHEN** the test runs `inflexa project ls` as a subprocess with the env of the test server
- **THEN** the command lists the seeded project

#### Scenario: A runtime route answers unavailable by default

- **WHEN** a test sends a request to a route that needs the runtime, on a test server with the default boot
- **THEN** the server answers 503 `unavailable`

### Requirement: Async CLI subprocess helper

The harness SHALL provide an async variant of the CLI subprocess helper, which spawns the same command line and waits for the exit without a block of the event loop of the test process. A test of an instance command against a test server SHALL use it, because the test server answers from the event loop of the same process, and a synchronous spawn would wait on itself. The async helper SHALL send the output of the child to files and read them after the exit, for the same reason as the synchronous helper.

#### Scenario: An instance command completes against an in-process server

- **WHEN** a test runs an instance command with the async helper and the env of a test server
- **THEN** the helper returns `{ exitCode, stdout, stderr }` of the real process, and the server answered each request of the child
