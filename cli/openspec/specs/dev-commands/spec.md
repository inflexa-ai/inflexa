# dev-commands Specification

## Purpose
The command-channel contract: which CLI commands are dev-only (`chat`, `profile`, `run`), how the channel is determined (the `INFLEXA_BUILD_CHANNEL` baked build constant with the non-baked `INFLEXA_DEV=1` runtime escape hatch), and what the production command surface is. Lives in `src/lib/env.ts` (`devCommandsEnabled`) and `src/cli/index.ts` (the gated registration block).

## Requirements

### Requirement: The command surface is channel-gated at registration

The CLI SHALL register its dev/E2E commands — `chat`, `profile`, and `run` — only when the dev
channel is active, so a release build's command surface is the product alone: bare `inflexa`,
`new`, `ls`, `resume`, `open`, `status`, `sessions`, `analysis`, `project`, `prov`, `repair`,
`relocate`, `prune`, `auth`, `up`, `down`, `setup`, `sandbox`, and `config`. Gating SHALL happen at
registration — an absent command: not present in help, and invoking the name fails non-zero as an
unrecognized argument (commander's root default action accepts no positionals, so an unregistered
name is rejected with an excess-argument error) — never as a runtime refusal inside a registered
command.

#### Scenario: Release binary omits the dev commands

- **WHEN** a binary built with the release channel runs `--help` or invokes `chat`/`profile`/`run`
- **THEN** the three commands are absent from help and invoking them exits non-zero as an unrecognized argument

#### Scenario: The dev runtime keeps them

- **WHEN** the CLI runs from source (`bun run dev`)
- **THEN** `chat`, `profile`, and `run` are registered and behave per their own specs

### Requirement: The channel is a baked build constant with a runtime escape hatch

The channel SHALL be determined by a compile-time constant baked through the existing
`bakedEnv`/`scripts/build.ts` mechanism (a release build declares the release channel; the
missing-var guard makes an undeclared channel a build failure, never a silent default), and the
source-run dev default SHALL be "dev". A deliberately NON-baked environment variable
(`INFLEXA_DEV=1`) SHALL remain readable at runtime even inside a compiled binary, re-enabling the
dev commands on a shipped build for support/debugging.

#### Scenario: Escape hatch on a release binary

- **WHEN** a release binary runs with `INFLEXA_DEV=1` in the environment
- **THEN** the dev commands are registered for that invocation

#### Scenario: Release builds must declare the channel

- **WHEN** a release build runs without the channel variable set
- **THEN** the build fails with the baked-var missing error (no silent dev-channel release)
