# test-harness — Delta

## ADDED Requirements

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

## MODIFIED Requirements

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

#### Scenario: Root test invocation aborts before any test body

- **WHEN** `bun test` is invoked from the repository root, with or without an explicit test-file path
- **THEN** the process SHALL exit non-zero before executing any test
- **AND** the message SHALL direct the user to run from the owning subsystem's directory

#### Scenario: The root config does not leak into a subsystem run

- **WHEN** `bun test` is invoked from `cli/`
- **THEN** `cli/bunfig.toml` SHALL apply and the root refusal preload SHALL NOT run
