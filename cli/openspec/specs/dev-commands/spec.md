# dev-commands Specification

## Purpose
The command-channel contract: which CLI commands are dev-only (`chat`, `profile`, `run`), how the channel is determined (the `INFLEXA_BUILD_CHANNEL` baked build constant — values `production` | `development` — with the non-baked `INFLEXA_DEV=1` runtime escape hatch), and what the production command surface is. Lives in `src/lib/env.ts` (`devCommandsEnabled`) and `src/cli/index.ts` (the gated registration block).

## Requirements

### Requirement: The command surface is channel-gated at registration

The CLI SHALL register its dev/E2E commands — `chat`, `profile`, and `run` — only when the
development channel is active, so a production build's command surface is the product alone: bare
`inflexa`, `config`, `new`, `ls`, `resume`, `open`, `status`, `usage`, `inputs`, `serve`, `server`,
`gui`, `analysis`, `project`, `prov`, `repair`, `relocate`, `prune`, `upgrade`, `geo`, `auth`, `up`,
`down`, `setup`, `refs`, `sandbox`, `store`, and `sbom`. Gating SHALL happen at registration — an absent command: not
present in help, and invoking the name fails non-zero as an unrecognized argument (commander's root
default action accepts no positionals, so an unregistered name is rejected with an excess-argument
error) — never as a runtime refusal inside a registered command.

The local server and its `serve` and `server` commands SHALL be part of the production surface,
because each product client depends on the server. The dev commands SHALL be clients of the local
server, the same as the product commands: `chat` runs each turn through the server, `profile` asks
the server for the profile, and `run --status` reads the runs from the server. `run --plan` SHALL
be the one exception: it boots its own harness runtime, and the runtime lock of the machine refuses
it while a server holds the runtime.

#### Scenario: Production binary omits the dev commands

- **WHEN** a binary built with the `production` channel runs `--help` or invokes `chat`/`profile`/`run`
- **THEN** the three commands are absent from help and invoking them exits non-zero as an unrecognized argument

#### Scenario: The dev runtime keeps them

- **WHEN** the CLI runs from source (`bun run dev`)
- **THEN** `chat`, `profile`, and `run` are registered and behave per their own specs

#### Scenario: Production binary carries the server commands

- **WHEN** a binary built with the `production` channel runs `--help`
- **THEN** `serve` and `server` are present

#### Scenario: Production binary carries the browser sign-in command

- **WHEN** a binary built with the `production` channel runs `--help`
- **THEN** `gui` is present

#### Scenario: A dev command is a client of the server

- **WHEN** a developer runs `inflexa profile` with no server running
- **THEN** the command starts the local server in the background, and asks it for the profile

#### Scenario: A plan replay keeps its own runtime

- **WHEN** a developer runs `inflexa run --plan <file>` while a local server holds the runtime
- **THEN** the boot of the command fails on the runtime lock, and no second runtime starts

### Requirement: The channel is a baked build constant with a runtime escape hatch

The channel SHALL be determined by a compile-time constant baked through the existing
`bakedEnv`/`scripts/build.ts` mechanism (a production build declares the `production` channel; the
missing-var guard makes an undeclared channel a build failure, never a silent default, and
`scripts/build.ts` SHALL reject a channel that is neither `production` nor `development`), and the
source-run default channel SHALL be development (unset). A deliberately NON-baked environment variable
(`INFLEXA_DEV=1`) SHALL remain readable at runtime even inside a compiled binary, re-enabling the
dev commands on a shipped build for support/debugging.

The build-mode signal SHALL be single-sourced from `INFLEXA_BUILD_CHANNEL`: `scripts/build.ts` SHALL
`--define` `process.env.NODE_ENV` from that same channel value so bundled dependencies compile in the
matching mode, and application code SHALL NOT read `process.env.NODE_ENV` as a product-mode signal (an
ESLint rule forbids it, `env.ts` included) — the two signals cannot diverge because one is derived from
the other at the single build authority. Exactly one read is sanctioned, disabled inline in `env.ts`:
the test-sandbox guard (see `test-harness`), which asks whether the process is a `bun test` run — a
question the channel cannot answer, since a source run and a test run both leave it unset.

#### Scenario: Escape hatch on a production binary

- **WHEN** a production binary runs with `INFLEXA_DEV=1` in the environment
- **THEN** the dev commands are registered for that invocation

#### Scenario: Builds must declare the channel

- **WHEN** a build runs without the channel variable set
- **THEN** the build fails with the baked-var missing error (no silent development-channel production build)

### Requirement: A production build without a baked source commit fails at build time

`scripts/build.ts` SHALL refuse to produce a binary when the resolved build channel is `production` and
`INFLEXA_GIT_COMMIT` is unset or empty, printing the reason and exiting non-zero. The commit SHALL then
be `--define`d into the bundle so the runtime read resolves to a baked literal.

The commit is consumed by the provenance `system` actor, and provenance is never allowed to degrade to
unsigned or to a fabricated value — so a binary that cannot stamp it is a broken build. Discovering that
at build time is the operator's problem to fix; discovering it at runtime is the user's crash on their
first provenance-recording command.

The define SHALL be explicit rather than routed through the `bakedEnv` block's scanner: the scanner's
missing-variable guard applies to every channel, and a `development` build outside a git checkout must
still be allowed to fall through to resolving the commit from `git rev-parse` at runtime.

`src/lib/env.ts` SHALL keep its runtime throw for a `production` channel with no commit, documented as a
backstop reachable only by a binary built without `scripts/build.ts` — not, as previously claimed, as
dead code guaranteed unreachable by a `--define` that the scanner never emitted.

#### Scenario: A production build without a commit is refused

- **WHEN** `scripts/build.ts` runs with `INFLEXA_BUILD_CHANNEL=production` and no `INFLEXA_GIT_COMMIT`
- **THEN** it SHALL print the reason and exit non-zero
- **AND** no binary SHALL be emitted

#### Scenario: A production build bakes the commit

- **WHEN** `scripts/build.ts` runs with `INFLEXA_BUILD_CHANNEL=production` and a resolved commit
- **THEN** `process.env.INFLEXA_GIT_COMMIT` SHALL be `--define`d into the bundle
- **AND** the resulting binary SHALL stamp provenance without shelling out to `git`

#### Scenario: A development build outside a git checkout still builds

- **WHEN** `scripts/build.ts` runs with `INFLEXA_BUILD_CHANNEL=development` and no resolvable commit
- **THEN** the build SHALL succeed
- **AND** the binary SHALL resolve the commit from `git rev-parse` at runtime, as the development path already does

### Requirement: The dev-only command surfaces live under one directory

These surfaces serve the dev channel alone, and each one MUST live under
`src/modules/harness/dev/`:

- the `chat` REPL, with the stdout printer that it builds
- the `run` launcher
- the `profile` command actions
- the status readers that only those commands call

The tree MUST then state the channel of a file. It states it beside the registration gate
at `src/cli/index.ts`, which already states it.

The dependency MUST run one way. A file under `dev/` can import product code, because a dev
surface is a consumer of the product. A product file MUST NOT import a path under `dev/`.

The gated registration block in `src/cli/index.ts` is the one sanctioned crossing. It reaches each
command action through the lazy `import()` that registration already uses. That call sits inside
`devCommandsEnabled()`, so a release build never evaluates it. Each other file outside `dev/` MUST
NOT import a path under it. That ban covers the static form and the dynamic form alike.

A lint rule MUST enforce that direction for a static import, so the boundary fails a build rather
than a review. The rule MUST exempt the files under `dev/`. It MUST NOT exempt the registration
gate, because the crossings of the gate are dynamic and the rule does not read a dynamic import.
Thus the gate keeps the guard against a static import. The rule MUST match the import string, not a
resolved path. A sibling reaches the directory as `./dev/<file>`, which a pattern anchored on the
full module path never matches.

A helper that both a product surface and a dev surface call MUST stay outside `dev/`, in
the module that owns its subject. A shared helper MUST NOT move into `dev/` because a dev
surface calls it. A dev-only helper MUST NOT stay outside `dev/` when no product file calls
it. When one file holds both kinds, that file MUST split on the channel line rather than
move whole.

This requirement is about location. It adds no gate, and it changes no behavior. The
channel gate stays at registration, per "The command surface is channel-gated at
registration".

#### Scenario: The dev surfaces sit under the dev directory

- **WHEN** a reader lists `src/modules/harness/`
- **THEN** the `chat` REPL, the `run` launcher, and the `profile` command actions are absent from that level
- **AND** `src/modules/harness/dev/` holds them

#### Scenario: Only the gated registry imports the dev directory

- **GIVEN** any file outside `src/modules/harness/dev/` other than `src/cli/index.ts`
- **WHEN** its imports are read
- **THEN** none of them resolves to a path under `src/modules/harness/dev/`

#### Scenario: The registry reaches the dev actions behind the gate

- **GIVEN** `src/cli/index.ts`
- **WHEN** its imports of `src/modules/harness/dev/` are read
- **THEN** each one is a lazy `import()` inside the `devCommandsEnabled()` block
- **AND** none is a top-level import that a release build would evaluate

#### Scenario: A helper with a product consumer stays outside

- **GIVEN** `seedProfileLedger`, which the product parity trigger `profile_trigger.ts` imports
- **WHEN** the dev surfaces are homed under `dev/`
- **THEN** `seedProfileLedger` stays outside `dev/`
- **AND** the dev `profile` command actions import it from there

#### Scenario: The lint rule refuses a product file's static import

- **GIVEN** a file under `src/` that is not in `dev/`, the registration gate included
- **WHEN** it declares a static import of a path under `src/modules/harness/dev/`
- **THEN** `bun run lint` reports a `no-restricted-imports` error naming the boundary
- **AND** the error fires for a sibling's `./dev/<file>` form and for a deep `../modules/harness/dev/<file>` form alike

#### Scenario: The lint rule leaves the sanctioned traffic alone

- **GIVEN** a file under `src/modules/harness/dev/` that imports another file in that directory
- **WHEN** `bun run lint` runs
- **THEN** it reports no error for that import
- **AND** the registration gate's three lazy imports report none either

#### Scenario: A mixed file splits on the channel line

- **GIVEN** one file that holds both a product export and a dev-only export
- **WHEN** the dev surfaces are homed under `dev/`
- **THEN** the product export stays outside `dev/`, and the dev-only export moves in
- **AND** neither part keeps a re-export shim at the old path
