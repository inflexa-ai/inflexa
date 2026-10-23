# Spec Delta

## MODIFIED Requirements

### Requirement: Postgres is provisioned via Docker Compose alongside the proxy

The CLI SHALL manage CLIProxyAPI (in cliproxy mode), Postgres, and SearXNG as services in a single Docker Compose file, generated into the CLI's data dir. The services SHALL share a network so inter-container communication uses service names rather than host port mapping. The Postgres service SHALL publish the configured port to `localhost` and SHALL persist its data directory under the CLI's data dir via a bind mount at `/var/lib/postgresql` (the PG 18+ parent mount). The SearXNG service SHALL be defined in every connection mode, per the SearXNG requirements of `searxng-provisioning`.

Every service image SHALL be pinned by version tag AND manifest digest (`<name>:<tag>@sha256:<digest>`), and NONE is user-overridable: the proxy as `eceasy/cli-proxy-api:v7.3.17@sha256:a1dffb9c2300099039d9e2dd3dbf6396a72b798c891fe170940d2d8106222a8c`, Postgres as `pgvector/pgvector:0.8.5-pg18@sha256:12a379b47ad65289572ea0756efc11b7c241a6662833e8af7038cd3b73d647e0`, and SearXNG per its own requirement. A floating tag (`latest`, a bare major like `pg18`) SHALL NOT appear in the generated compose file: the launch gate's credential classifications are calibrated against verified proxy behavior, and an upstream push must never change that behavior under an unchanged install — the digest additionally makes a republished tag inert. Bumping a pin is a deliberate code change whose procedure (update tag+digest together, re-verify the launch-gate calibration points) is documented at the pin site.

#### Scenario: First-time provisioning creates the compose file and starts both services

- **WHEN** `inflexa setup` runs and no compose file exists
- **THEN** the CLI generates a `docker-compose.yml` in the data dir defining the mode's services — Postgres and SearXNG always, the proxy in cliproxy mode — on a shared network
- **AND** runs `{runtime} compose up -d` to start the services
- **AND** the Postgres container reports ready via `pg_isready`

#### Scenario: Existing running containers are reused

- **WHEN** `inflexa setup` runs and the containers are already running
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
- **THEN** every service image reference carries an explicit version tag and a manifest digest, and none is `latest` nor a bare major-version tag

### Requirement: Container names are environment-aware

The ENTIRE stack identity SHALL be environment-aware, determined by `env.isDevelopment` (derived from the baked `INFLEXA_BUILD_CHANNEL` — `isDevelopment` is true unless the `production` channel was baked in, never keyed on `NODE_ENV`): container and network names (`inflexa-` prefix in production, `inflexa-dev-` in dev), the published host ports (production: proxy 8317, postgres default 8432, SearXNG 28437; dev: proxy 8318, postgres default 8434, SearXNG 28438), the generated compose file path, and the host-side mount sources (the CLIProxyAPI config + credential dir, the Postgres data dir, and the SearXNG settings file). The adjacent harness DBOS admin port — the host HTTP listener the harness runtime binds, not a published container port — SHALL be channel-aware on the same signal (production 8433, dev 8435), so the simultaneity guarantee holds across every host listener a channel binds, not only the container-published ports. The local server is one more such host listener: its port SHALL be channel-aware on the same signal (production 8431, dev 8436), and so SHALL its discovery file and its log. Production paths and ports SHALL be identical to their historical values, so existing installs are untouched; the SearXNG port is new, and its production and dev defaults SHALL NOT collide with each other or with the historical set. This prevents a developer's `bun run dev` stack from colliding with an installed binary's stack in ANY shared resource: a port bind, a compose file one build regenerates against the other, a Postgres data dir, a server discovery file whose token a client of the other channel would send, or — most dangerously — a shared provider credential file, which two independently-refreshing proxies would corrupt through OAuth refresh-token rotation. Under each channel's defaults — and under any explicit override the user picks that does not itself collide — the two stacks SHALL be able to run simultaneously. The one exception is by design: an explicitly persisted `postgres.port` applies to BOTH channels (per the per-field override contract) and so reintroduces contention on that single port — a consequence the customizing user owns.

#### Scenario: Dev container names

- **WHEN** the CLI runs in dev mode
- **THEN** container names are `inflexa-dev-cliproxy`, `inflexa-dev-postgres`, and `inflexa-dev-searxng`, and the network is `inflexa-dev`

#### Scenario: Production container names

- **WHEN** the CLI runs as a compiled binary
- **THEN** container names are `inflexa-cliproxy`, `inflexa-postgres`, and `inflexa-searxng`, and the network is `inflexa`

#### Scenario: Dev and production stacks run simultaneously

- **WHEN** an installed binary's stack is up and `bun run dev` brings up the dev stack, with no `postgres.port` persisted to the shared `config.json` (each channel resolving its own default port)
- **THEN** both stacks run concurrently — no port contention, and neither reads nor writes the other's compose file, proxy config, credential dir, Postgres data dir, or SearXNG settings file

#### Scenario: Dev and production servers run simultaneously

- **WHEN** a production local server runs and a dev local server starts
- **THEN** the two bind different ports, and each client reads the discovery file of its own channel only

#### Scenario: Production paths and ports are unchanged

- **WHEN** the CLI runs as a compiled binary after this change
- **THEN** every pre-change stack path and published port is byte-identical to its pre-change value, the new SearXNG port excepted, and existing containers, credentials, and data are picked up as-is

#### Scenario: A dev stack never touches the production credential

- **WHEN** the dev launch gate needs a provider credential and only the production credential dir holds one
- **THEN** the dev flow treats itself as not authenticated and drives its own sign-in into the dev credential dir, leaving the production credential file unread and unwritten

### Requirement: `inflexa up` starts the infrastructure containers

`inflexa up` MUST run the gate of the server boot (`ensureProxyReady`), with the login prompt on a terminal. In cliproxy mode, the gate writes the proxy config before the engine runs. Then it signs in when no credential exists. The gate MUST then generate the compose file for the connection mode, pull the missing images, and start each compose-managed container, SearXNG included in every mode. Each bind-mount source MUST exist with the correct type before the compose step, per the mount-source integrity requirement of infra-state-resilience, the SearXNG settings file included. In cliproxy mode, the gate then probes the live credential, and on a terminal it offers the re-login, per `cliproxy-credential-health`.

The command MUST be idempotent. A failure MUST print the reason and exit with code 1. After a success, the command MUST print the proxy URL and the Postgres port, and ask a failed server to boot again, per `local-server`.

#### Scenario: Start containers from a clean state

- **WHEN** `inflexa up` runs and no containers are running
- **THEN** the compose file is generated (if missing) and `compose up -d` starts the services of the mode, SearXNG included
- **AND** the command prints the proxy URL and Postgres port

#### Scenario: `up` with no proxy config provisions it first

- **WHEN** `inflexa up` runs in cliproxy mode and the proxy config file does not exist
- **THEN** the proxy config is written before `compose up -d`, and no directory is manufactured at the config file's path

#### Scenario: `up` signs in on a terminal

- **GIVEN** cliproxy mode and no provider credential on disk
- **WHEN** the person runs `inflexa up` in a terminal
- **THEN** the command offers the provider sign-in before it starts the containers

#### Scenario: `up` with no terminal and no credential

- **GIVEN** cliproxy mode and no provider credential on disk
- **WHEN** `inflexa up` runs with no terminal
- **THEN** the command prints that `inflexa up` in a terminal signs in, and it exits with code 1

### Requirement: `inflexa down` stops the infrastructure containers

`inflexa down` SHALL stop and remove all compose-managed containers, SearXNG included, and the shared network. With `--delete-data`, it SHALL also delete the Postgres data directory and the proxy credentials directory, but only after the user types exactly "I understand" at a confirmation prompt. Non-interactive terminals SHALL decline the destructive confirmation.

`inflexa down` stops the Postgres of a live local server, which is the backend of each client. Thus it SHALL refuse while a local server runs, before any prompt and before any container work. It SHALL refuse in each of these cases:

- The discovery file of the channel names a server that answers.
- The discovery file names a process that lives but does not answer.
- No live discovery file exists, but a listener answers on the server port of the channel.

The refusal SHALL name `inflexa server stop` as the remedy.

#### Scenario: Stop containers

- **WHEN** `inflexa down` runs
- **THEN** `compose down` stops the compose-managed containers, SearXNG included, and removes the shared network

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
