# Spec Delta

## MODIFIED Requirements

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
