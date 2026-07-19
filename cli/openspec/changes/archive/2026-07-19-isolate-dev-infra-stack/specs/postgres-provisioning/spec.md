## MODIFIED Requirements

### Requirement: Postgres is provisioned via Docker Compose alongside the proxy

The CLI SHALL manage both CLIProxyAPI and Postgres as services in a single Docker Compose file, generated into the CLI's data dir. Both services SHALL share a network so inter-container communication uses service names rather than host port mapping. The Postgres service SHALL publish the configured port to `localhost` and SHALL persist its data directory under the CLI's data dir via a bind mount at `/var/lib/postgresql` (the PG 18+ parent mount).

Both service images SHALL be pinned by version tag AND manifest digest (`<name>:<tag>@sha256:<digest>`), and NEITHER is user-overridable: the proxy as `eceasy/cli-proxy-api:v7.2.90@sha256:6aa1ffb6616bff0b35d76cff89761ee7d54704d33d0c0c4f5ce7f3bffa9d73d2`, Postgres as `pgvector/pgvector:0.8.5-pg18@sha256:12a379b47ad65289572ea0756efc11b7c241a6662833e8af7038cd3b73d647e0`. A floating tag (`latest`, a bare major like `pg18`) SHALL NOT appear in the generated compose file: the launch gate's credential classifications are calibrated against verified proxy behavior, and an upstream push must never change that behavior under an unchanged install — the digest additionally makes a republished tag inert. Bumping a pin is a deliberate code change whose procedure (update tag+digest together, re-verify the launch-gate calibration points) is documented at the pin site.

#### Scenario: First-time provisioning creates the compose file and starts both services

- **WHEN** `inflexa setup` runs and no compose file exists
- **THEN** the CLI generates a `docker-compose.yml` in the data dir defining both services on a shared network
- **AND** runs `{runtime} compose up -d` to start both services
- **AND** the Postgres container reports ready via `pg_isready`

#### Scenario: Existing running containers are reused

- **WHEN** `inflexa setup` runs and both containers are already running
- **THEN** the CLI does NOT recreate them and reports them already ready

#### Scenario: Stopped containers are started via compose

- **WHEN** `inflexa setup` runs and containers exist but are stopped
- **THEN** the CLI runs `compose up -d` which starts the existing containers without discarding data

#### Scenario: Provisioning uses the active runtime's compose subcommand

- **WHEN** the active runtime is `podman` and a compose command is issued
- **THEN** the command runs via `podman compose` (not `docker compose`)

#### Scenario: Pre-existing standalone containers are migrated

- **WHEN** containers with the same names exist but were created by individual `docker run` (not compose)
- **THEN** the CLI removes them before running `compose up -d` so compose can recreate them

#### Scenario: Neither image floats

- **WHEN** the compose file is generated in any mode or channel
- **THEN** both service image references carry an explicit version tag and a manifest digest, and neither is `latest` nor a bare major-version tag

### Requirement: Container names are environment-aware

The ENTIRE stack identity SHALL be environment-aware, determined by `env.isDevelopment` (derived from the baked `INFLEXA_BUILD_CHANNEL` — `isDevelopment` is true unless the `production` channel was baked in, never keyed on `NODE_ENV`): container and network names (`inflexa-` prefix in production, `inflexa-dev-` in dev), the published host ports (production: proxy 8317, postgres default 8432; dev: proxy 8318, postgres default 8434), the generated compose file path, and the host-side mount sources (the CLIProxyAPI config + credential dir and the Postgres data dir). The adjacent harness DBOS admin port — the host HTTP listener the harness runtime binds, not a published container port — SHALL be channel-aware on the same signal (production 8433, dev 8435), so the simultaneity guarantee holds across every host listener a channel binds, not only the two container-published ports. Production paths and ports SHALL be identical to their historical values, so existing installs are untouched. This prevents a developer's `bun run dev` stack from colliding with an installed binary's stack in ANY shared resource: a port bind, a compose file one build regenerates against the other, a Postgres data dir, or — most dangerously — a shared provider credential file, which two independently-refreshing proxies would corrupt through OAuth refresh-token rotation. The two stacks SHALL be able to run simultaneously.

#### Scenario: Dev container names

- **WHEN** the CLI runs in dev mode
- **THEN** container names are `inflexa-dev-cliproxy` and `inflexa-dev-postgres`, and the network is `inflexa-dev`

#### Scenario: Production container names

- **WHEN** the CLI runs as a compiled binary
- **THEN** container names are `inflexa-cliproxy` and `inflexa-postgres`, and the network is `inflexa`

#### Scenario: Dev and production stacks run simultaneously

- **WHEN** an installed binary's stack is up and `bun run dev` brings up the dev stack
- **THEN** both stacks run concurrently — no port contention, and neither reads nor writes the other's compose file, proxy config, credential dir, or Postgres data dir

#### Scenario: Production paths and ports are unchanged

- **WHEN** the CLI runs as a compiled binary after this change
- **THEN** every stack path and published port is byte-identical to its pre-change value, and existing containers, credentials, and data are picked up as-is

#### Scenario: A dev stack never touches the production credential

- **WHEN** the dev launch gate needs a provider credential and only the production credential dir holds one
- **THEN** the dev flow treats itself as not authenticated and drives its own sign-in into the dev credential dir, leaving the production credential file unread and unwritten

### Requirement: Setup prompts for Postgres credentials and port

`inflexa setup` SHALL interactively prompt the user for Postgres username (default `inflexa`), password (default `inflexa`), and port (default: the channel-aware `env.postgresPort`) using `@clack/prompts` with `defaultValue` and `placeholder` so pressing Enter accepts the default. Only explicit choices SHALL be persisted to `config.json` under the `postgres` key — a value that differs from its (channel-aware) default. A value equal to its default SHALL NOT be persisted: `config.json` is shared by both build channels, so freezing an accepted default (chiefly the port) would override the other channel's sibling default and re-create the very stack collision environment-aware defaults remove. An explicitly customized value, by contrast, SHALL be persisted and therefore applies to BOTH channels — deliberate, per the per-field override contract; a user who customizes the port on a dual-build machine owns that cross-channel consequence, an explicit value keeping its win over each channel's sibling default. The persisted block SHALL be rebuilt from the prompted values (never merged over the previous block), so a setup re-run that accepts defaults also heals a default frozen by an earlier run. The prompted values SHALL be used in the generated compose file for this run regardless of what is persisted. On non-interactive terminals, the current resolution SHALL be used silently without prompting or persisting.

#### Scenario: Interactive terminal prompts for credentials

- **WHEN** `inflexa setup` runs on a TTY and reaches the Postgres step
- **THEN** the CLI prompts for username, password, and port showing the current/default value as placeholder
- **AND** pressing Enter accepts the default without typing

#### Scenario: Accepted defaults persist nothing

- **WHEN** the user accepts every prompted default
- **THEN** no `postgres` field is written to `config.json`, and each channel keeps resolving its own defaults

#### Scenario: A custom value is persisted and an accepted default is not

- **WHEN** the user enters a custom password but accepts the default port
- **THEN** `config.json` carries `postgres.password` and no `postgres.port`

#### Scenario: A frozen default is healed on re-accept

- **WHEN** `config.json` carries a `postgres.port` equal to the channel default (frozen by an earlier setup) and the user re-runs setup accepting the prompted defaults
- **THEN** the persisted `postgres.port` is removed, and each channel resolves its own default port again

#### Scenario: Non-interactive terminal uses defaults silently

- **WHEN** `inflexa setup` runs on a non-TTY (pipe, CI)
- **THEN** the CLI uses the current resolution without prompting and writes nothing

#### Scenario: Prompted values are used in compose file

- **WHEN** the user enters custom credentials during setup
- **THEN** the generated compose file uses those credentials as the `POSTGRES_USER`, `POSTGRES_PASSWORD`, and published port
