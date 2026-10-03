## MODIFIED Requirements

### Requirement: Container names are environment-aware

The ENTIRE stack identity SHALL be environment-aware, determined by `env.isDevelopment` (derived from the baked `INFLEXA_BUILD_CHANNEL` — `isDevelopment` is true unless the `production` channel was baked in, never keyed on `NODE_ENV`): container and network names (`inflexa-` prefix in production, `inflexa-dev-` in dev), the published host ports (production: proxy 8317, postgres default 8432; dev: proxy 8318, postgres default 8434), the generated compose file path, and the host-side mount sources (the CLIProxyAPI config + credential dir and the Postgres data dir). The adjacent harness DBOS admin port — the host HTTP listener the harness runtime binds, not a published container port — SHALL be channel-aware on the same signal (production 8433, dev 8435), so the simultaneity guarantee holds across every host listener a channel binds, not only the two container-published ports. The local server is one more such host listener: its port SHALL be channel-aware on the same signal (production 8431, dev 8436), and so SHALL its discovery file and its log. Production paths and ports SHALL be identical to their historical values, so existing installs are untouched. This prevents a developer's `bun run dev` stack from colliding with an installed binary's stack in ANY shared resource: a port bind, a compose file one build regenerates against the other, a Postgres data dir, a server discovery file whose token a client of the other channel would send, or — most dangerously — a shared provider credential file, which two independently-refreshing proxies would corrupt through OAuth refresh-token rotation. Under each channel's defaults — and under any explicit override the user picks that does not itself collide — the two stacks SHALL be able to run simultaneously. The one exception is by design: an explicitly persisted `postgres.port` applies to BOTH channels (per the per-field override contract) and so reintroduces contention on that single port — a consequence the customizing user owns.

#### Scenario: Dev container names

- **WHEN** the CLI runs in dev mode
- **THEN** container names are `inflexa-dev-cliproxy` and `inflexa-dev-postgres`, and the network is `inflexa-dev`

#### Scenario: Production container names

- **WHEN** the CLI runs as a compiled binary
- **THEN** container names are `inflexa-cliproxy` and `inflexa-postgres`, and the network is `inflexa`

#### Scenario: Dev and production stacks run simultaneously

- **WHEN** an installed binary's stack is up and `bun run dev` brings up the dev stack, with no `postgres.port` persisted to the shared `config.json` (each channel resolving its own default port)
- **THEN** both stacks run concurrently — no port contention, and neither reads nor writes the other's compose file, proxy config, credential dir, or Postgres data dir

#### Scenario: Dev and production servers run simultaneously

- **WHEN** a production local server runs and a dev local server starts
- **THEN** the two bind different ports, and each client reads the discovery file of its own channel only

#### Scenario: Production paths and ports are unchanged

- **WHEN** the CLI runs as a compiled binary after this change
- **THEN** every stack path and published port is byte-identical to its pre-change value, and existing containers, credentials, and data are picked up as-is

#### Scenario: A dev stack never touches the production credential

- **WHEN** the dev launch gate needs a provider credential and only the production credential dir holds one
- **THEN** the dev flow treats itself as not authenticated and drives its own sign-in into the dev credential dir, leaving the production credential file unread and unwritten

### Requirement: `inflexa down` stops the infrastructure containers

`inflexa down` SHALL stop and remove all compose-managed containers and the shared network. With `--delete-data`, it SHALL also delete the Postgres data directory and the proxy credentials directory, but only after the user types exactly "I understand" at a confirmation prompt. Non-interactive terminals SHALL decline the destructive confirmation.

`inflexa down` stops the Postgres of a live local server, which is the backend of each client. Thus it SHALL refuse while a local server runs, before any prompt and before any container work. It SHALL refuse in each of these cases:

- The discovery file of the channel names a server that answers.
- The discovery file names a process that lives but does not answer.
- No live discovery file exists, but a listener answers on the server port of the channel.

The refusal SHALL name `inflexa server stop` as the remedy.

#### Scenario: Stop containers

- **WHEN** `inflexa down` runs
- **THEN** `compose down` stops both containers and removes the shared network

#### Scenario: Delete data with confirmation

- **WHEN** `inflexa down --delete-data` runs and the user types "I understand"
- **THEN** the containers are stopped, the Postgres data directory is deleted, and the proxy credentials directory is deleted

#### Scenario: Delete data rejected

- **WHEN** `inflexa down --delete-data` runs and the user does NOT type "I understand"
- **THEN** no data is deleted and the command aborts

#### Scenario: A running server refuses the stop

- **GIVEN** a local server that runs
- **WHEN** `inflexa down` runs
- **THEN** the command exits non-zero, names `inflexa server stop`, and no container stops

### Requirement: Settings TUI exposes Postgres fields

The settings TUI SHALL expose a Postgres section covering `host`, `port`, `database`, `user`, `password`. The settings are keys of the local server: the TUI SHALL read them from the server and save each edit through the server, which persists it to `config.json`. The server SHALL send the resolved connection, and in place of the password only whether the config holds one. Thus `host`, `port`, `database`, and `user` SHALL be visible in clear text and editable, and the password SHALL be write-only: an entered password replaces the stored one, and no entry keeps it. A saved change SHALL apply at the next boot of the runtime of the server. There SHALL be no `mode` or `image` fields.

#### Scenario: Editing a field persists to config

- **WHEN** the user edits `postgres.port` to `5433` in settings and saves
- **THEN** the value is written to `config.json` and is the resolved port at the next boot of the server runtime

#### Scenario: The stored password never reaches the screen

- **GIVEN** a config that holds a Postgres password
- **WHEN** the settings screen shows the Postgres section
- **THEN** the screen shows that a password is set, and never shows the password itself

#### Scenario: An untouched password stays

- **GIVEN** a config that holds a Postgres password
- **WHEN** the user saves a change to `postgres.port` and enters no password
- **THEN** the config keeps the stored password
