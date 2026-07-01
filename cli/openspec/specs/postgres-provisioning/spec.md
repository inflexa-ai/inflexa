## Purpose

Provision, configure, self-heal, and lifecycle a local Postgres + pgvector container that backs the embedded harness. The CLI manages both CLIProxyAPI and Postgres as services in a Docker Compose stack on a shared network. The module lives at `src/modules/infra/` (the infrastructure module).

## Requirements

### Requirement: Postgres is provisioned via Docker Compose alongside the proxy

The CLI SHALL manage both CLIProxyAPI and Postgres as services in a single Docker Compose file, generated into the CLI's data dir. Both services SHALL share a network so inter-container communication uses service names rather than host port mapping. The Postgres service SHALL use the `pgvector/pgvector:pg18` image (fixed, not user-overridable), SHALL publish the configured port to `localhost`, and SHALL persist its data directory under the CLI's data dir via a bind mount at `/var/lib/postgresql` (the PG 18+ parent mount).

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

### Requirement: Setup prompts for Postgres credentials and port

`inflexa setup` SHALL interactively prompt the user for Postgres username (default `inflexa`), password (default `inflexa`), and port (default `8432`) using `@clack/prompts` with `defaultValue` and `placeholder` so pressing Enter accepts the default. The prompted values SHALL be persisted to `config.json` under the `postgres` key and used in the generated compose file. On non-interactive terminals, the defaults SHALL be used silently without prompting.

#### Scenario: Interactive terminal prompts for credentials

- **WHEN** `inflexa setup` runs on a TTY and reaches the Postgres step
- **THEN** the CLI prompts for username, password, and port showing the current/default value as placeholder
- **AND** pressing Enter accepts the default without typing

#### Scenario: Non-interactive terminal uses defaults silently

- **WHEN** `inflexa setup` runs on a non-TTY (pipe, CI)
- **THEN** the CLI uses the default credentials without prompting

#### Scenario: Prompted values are used in compose file

- **WHEN** the user enters custom credentials during setup
- **THEN** the generated compose file uses those credentials as the `POSTGRES_USER`, `POSTGRES_PASSWORD`, and published port

### Requirement: Connection defaults, all per-field overridable

The CLI SHALL default database `inflexa`, user `inflexa`, password `inflexa`, host-published port `8432`. Every connection field — host, port, database, user, password — SHALL be individually overridable through the `postgres` key in `config.json`. Missing or partial config SHALL fall back per-field to these defaults and SHALL NOT fail boot. The image (`pgvector/pgvector:pg18`) is NOT user-overridable via config.

#### Scenario: Defaults when no config exists

- **WHEN** the config file has no `postgres` key
- **THEN** the resolved connection uses database `inflexa`, user `inflexa`, password `inflexa`, port `8432`

#### Scenario: Partial override keeps unset defaults

- **WHEN** the config file sets only `postgres.port` to `5433`
- **THEN** the resolved connection uses port `5433` and the default database, user, and password

#### Scenario: Explicit full override is honored

- **WHEN** the config file sets `postgres.{host,port,database,user,password}` to custom values
- **THEN** every one of those custom values is used in place of the defaults

### Requirement: pgvector is self-installed and verified at every gate

The CLI SHALL run `CREATE EXTENSION IF NOT EXISTS vector` in the configured database at every gate — both `inflexa setup` (after the container is ready) and the launch-time gate. The statement SHALL retry on transient connection failures (e.g. the PG Docker entrypoint's init-phase fast shutdown killing the connection) with a bounded timeout (30s). Permanent failures (missing extension files, privilege denied) SHALL fail immediately with an actionable error.

#### Scenario: Setup-time install succeeds

- **WHEN** `inflexa setup` runs and the Postgres container reports ready via `pg_isready`
- **THEN** the CLI runs `CREATE EXTENSION IF NOT EXISTS vector` via `docker exec psql`
- **AND** on success reports Postgres ready and continues

#### Scenario: Init-phase race absorbed by retry

- **WHEN** the first `CREATE EXTENSION` attempt hits the PG Docker entrypoint's init-phase fast shutdown
- **THEN** the CLI retries after a short interval and succeeds when the real server starts

#### Scenario: Extension install fails because extension files are absent

- **WHEN** `CREATE EXTENSION IF NOT EXISTS vector` fails because the pgvector files are not present
- **THEN** the CLI does NOT retry and exits with an actionable error naming the image

### Requirement: `inflexa setup` provisions Postgres alongside the proxy

`inflexa setup` SHALL provision Postgres as a step after the existing proxy provisioning step. The setup flow uses `@clack/prompts` throughout — `intro`/`outro` framing, `select` for provider picker, `spinner` for progress, `note` for summaries, `log.*` for status messages. The existing `--force` flag SHALL re-pull images via `compose pull`. The existing `--no-start` flag SHALL skip `compose up -d`. A `--no-postgres` flag SHALL skip the Postgres step entirely.

#### Scenario: Default setup provisions proxy then Postgres

- **WHEN** `inflexa setup` runs with no flags
- **THEN** the proxy is configured first, then the user is prompted for Postgres credentials, then `compose up -d` starts both services, then a next-steps note box names both endpoints

#### Scenario: `--force` re-pulls both images

- **WHEN** `inflexa setup --force` runs
- **THEN** both images are re-pulled via `compose pull` even if cached

#### Scenario: `--no-start` skips container starts

- **WHEN** `inflexa setup --no-start` runs
- **THEN** configs are written and compose file generated but `compose up -d` is not run

#### Scenario: `--no-postgres` skips only the Postgres step

- **WHEN** `inflexa setup --no-postgres` runs
- **THEN** the proxy is provisioned normally and the Postgres step is skipped

### Requirement: Auth URL is extracted and copied to clipboard

During provider authentication, the CLI SHALL capture the auth container's stdout/stderr (running without `-t` since `--no-browser` needs no PTY), extract the OAuth URL, copy it to the system clipboard, and print it as a plain unwrapped line (not inside a bordered box) so it is easily selectable. If an SSH tunnel command is detected, it SHALL be shown in a note box alongside the URL.

#### Scenario: Auth URL is captured and copied

- **WHEN** the auth container prints an OAuth URL
- **THEN** the URL is extracted, copied to clipboard, and printed as a plain indented line

#### Scenario: SSH tunnel command is shown for remote scenarios

- **WHEN** the auth container detects a remote scenario and prints SSH tunnel instructions
- **THEN** the SSH command is shown in a note box below the auth URL

### Requirement: Launch-time gate self-heals the Postgres substrate

A launch-time function SHALL run before any code path that integrates the harness. The gate is self-healing: when the substrate is missing or stopped, the gate SHALL provision it transparently. The gate SHALL generate the compose file if needed, run `compose up -d`, wait for `pg_isready`, and run the pgvector self-install (with retry). The gate SHALL surface progress messages while it works. The gate SHALL only exit non-zero when self-healing itself fails.

#### Scenario: First launch with no containers auto-provisions

- **WHEN** the launch-time gate runs, no compose file or containers exist, and the runtime is ready
- **THEN** the gate generates the compose file with default credentials, runs `compose up -d`, waits for `pg_isready`, runs the vector self-install, and proceeds

#### Scenario: Stopped containers are auto-started

- **WHEN** the launch-time gate runs and containers exist but are stopped
- **THEN** the gate runs `compose up -d`, waits for ready, runs the vector self-install, and proceeds

#### Scenario: Ready containers proceed without side effects

- **WHEN** the launch-time gate runs and containers are already running
- **THEN** the gate runs the vector self-install (a no-op when already present) and proceeds without restarting

### Requirement: Container lifecycle outlives a CLI session

The containers SHALL be configured with `restart: unless-stopped` in the compose file, so they outlive any single CLI invocation and survive host reboots (when the runtime has a daemon). The CLI SHALL NOT stop containers on shutdown.

#### Scenario: Second launch skips recreate

- **WHEN** a second CLI launch runs the readiness gate and containers are already running
- **THEN** no recreate is attempted and launch proceeds

### Requirement: Container names are environment-aware

Container and network names SHALL use an `inflexa-` prefix in production builds and `inflexa-dev-` in dev runs (`NODE_ENV !== "production"`). This prevents a developer's `bun run dev` containers from colliding with a user's installed binary's containers.

#### Scenario: Dev container names

- **WHEN** the CLI runs in dev mode
- **THEN** container names are `inflexa-dev-cliproxy` and `inflexa-dev-postgres`, and the network is `inflexa-dev`

#### Scenario: Production container names

- **WHEN** the CLI runs as a compiled binary
- **THEN** container names are `inflexa-cliproxy` and `inflexa-postgres`, and the network is `inflexa`

### Requirement: `inflexa up` starts the infrastructure containers

`inflexa up` SHALL start all compose-managed containers, generating the compose file if it doesn't exist. It is the user-initiated equivalent of the self-healing launch-time gate. The command SHALL be idempotent.

#### Scenario: Start containers from a clean state

- **WHEN** `inflexa up` runs and no containers are running
- **THEN** the compose file is generated (if missing) and `compose up -d` starts both services
- **AND** the command prints the proxy URL and Postgres port

### Requirement: `inflexa down` stops the infrastructure containers

`inflexa down` SHALL stop and remove all compose-managed containers and the shared network. With `--delete-data`, it SHALL also delete the Postgres data directory and the proxy credentials directory, but only after the user types exactly "I understand" at a confirmation prompt. Non-interactive terminals SHALL decline the destructive confirmation.

#### Scenario: Stop containers

- **WHEN** `inflexa down` runs
- **THEN** `compose down` stops both containers and removes the shared network

#### Scenario: Delete data with confirmation

- **WHEN** `inflexa down --delete-data` runs and the user types "I understand"
- **THEN** the containers are stopped, the Postgres data directory is deleted, and the proxy credentials directory is deleted

#### Scenario: Delete data rejected

- **WHEN** `inflexa down --delete-data` runs and the user does NOT type "I understand"
- **THEN** no data is deleted and the command aborts

### Requirement: Settings TUI exposes Postgres fields

The settings TUI SHALL expose a Postgres section covering `host`, `port`, `database`, `user`, `password`, persisting edits to `config.json`. Every field SHALL be visible in clear text and editable. There SHALL be no `mode` or `image` fields.

#### Scenario: Editing a field persists to config

- **WHEN** the user edits `postgres.port` to `5433` in settings and saves
- **THEN** the value is written to `config.json` and is the resolved port on the next launch

### Requirement: Paths appear in the help table

The `--help` output SHALL list the Postgres data directory and the compose file path in its Paths/Environment table, alongside the existing proxy paths.

#### Scenario: Postgres data dir surfaced in help

- **WHEN** the user runs `inflexa --help`
- **THEN** the Paths table contains rows for the Postgres data directory and the Docker Compose file
