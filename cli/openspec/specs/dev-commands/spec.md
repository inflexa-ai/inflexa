# dev-commands Specification

## Purpose
The command-channel contract: which CLI commands are dev-only (`chat`, `profile`, `run`), how the channel is determined (the `INFLEXA_BUILD_CHANNEL` baked build constant — values `production` | `development` — with the non-baked `INFLEXA_DEV=1` runtime escape hatch), and what the production command surface is. Lives in `src/lib/env.ts` (`devCommandsEnabled`) and `src/cli/index.ts` (the gated registration block).

## Requirements

### Requirement: The command surface is channel-gated at registration

The CLI SHALL register its dev/E2E commands — `chat`, `profile`, and `run` — only when the
development channel is active, so a production build's command surface is the product alone: bare
`inflexa`, `new`, `ls`, `resume`, `open`, `status`, `sessions`, `analysis`, `project`, `prov`,
`repair`, `relocate`, `prune`, `auth`, `up`, `down`, `setup`, `sandbox`, and `config`. Gating SHALL
happen at registration — an absent command: not present in help, and invoking the name fails non-zero
as an unrecognized argument (commander's root default action accepts no positionals, so an
unregistered name is rejected with an excess-argument error) — never as a runtime refusal inside a
registered command.

#### Scenario: Production binary omits the dev commands

- **WHEN** a binary built with the `production` channel runs `--help` or invokes `chat`/`profile`/`run`
- **THEN** the three commands are absent from help and invoking them exits non-zero as an unrecognized argument

#### Scenario: The dev runtime keeps them

- **WHEN** the CLI runs from source (`bun run dev`)
- **THEN** `chat`, `profile`, and `run` are registered and behave per their own specs

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
matching mode, and application code SHALL NOT read `process.env.NODE_ENV` directly (an ESLint rule
forbids it, `env.ts` included) — the two signals cannot diverge because one is derived from the other
at the single build authority.

#### Scenario: Escape hatch on a production binary

- **WHEN** a production binary runs with `INFLEXA_DEV=1` in the environment
- **THEN** the dev commands are registered for that invocation

#### Scenario: Builds must declare the channel

- **WHEN** a build runs without the channel variable set
- **THEN** the build fails with the baked-var missing error (no silent development-channel production build)
