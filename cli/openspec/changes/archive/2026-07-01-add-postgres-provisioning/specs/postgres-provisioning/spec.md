## ADDED Requirements

### Requirement: Postgres is provisioned via Docker Compose alongside the proxy

The CLI SHALL manage both CLIProxyAPI and Postgres as services in a single Docker Compose file, generated into the CLI's data dir. Both services SHALL share an `inflexa` network so inter-container communication uses service names (e.g. `inflexa-postgres:5432`) rather than host port mapping. The Postgres service SHALL use the `pgvector/pgvector:pg18` image (fixed, not user-overridable), SHALL be named `inflexa-postgres`, SHALL publish the configured port to `localhost`, and SHALL persist its data directory under the CLI's data dir via a bind mount.

#### Scenario: First-time provisioning creates the compose file and starts both services

- **WHEN** `inflexa setup` runs and no compose file exists
- **THEN** the CLI generates a `docker-compose.yml` in the data dir defining both `inflexa-cliproxy` and `inflexa-postgres` services on a shared `inflexa` network
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

### Requirement: Setup prompts for Postgres credentials and port

`inflexa setup` SHALL interactively prompt the user for Postgres username (default `inflexa`), password (default `inflexa`), and port (default `8432`) using `@clack/prompts`. The prompted values SHALL be persisted to `config.json` under the `postgres` key and used in the generated compose file. On non-interactive terminals, the defaults SHALL be used silently without prompting.

#### Scenario: Interactive terminal prompts for credentials

- **WHEN** `inflexa setup` runs on a TTY and reaches the Postgres step
- **THEN** the CLI prompts for username (showing default `inflexa`), password (showing default `inflexa`), and port (showing default `8432`)
- **AND** the user's answers are persisted to `config.json`

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

#### Scenario: Default port avoids the standard 5432 clash

- **WHEN** a user has a system PostgreSQL already bound to `localhost:5432`
- **THEN** the CLI default port `8432` does not collide and provisioning succeeds

### Requirement: pgvector is self-installed and verified at every gate

The CLI SHALL run `CREATE EXTENSION IF NOT EXISTS vector` in the configured database at every gate — both `inflexa setup` (after the container is ready) and the launch-time gate. The statement is both the probe and the install. In docker mode the statement SHALL be executed via the image's bundled `psql` using `docker exec inflexa-postgres psql -U {user} -d {database} -c "CREATE EXTENSION IF NOT EXISTS vector"`. When the `CREATE EXTENSION` fails (permission denied, extension files absent, unreachable server), the gate SHALL fail fast with an actionable error.

#### Scenario: Setup-time install succeeds

- **WHEN** `inflexa setup` runs and the Postgres container reports ready via `pg_isready`
- **THEN** the CLI runs `CREATE EXTENSION IF NOT EXISTS vector` via `docker exec psql`
- **AND** on success reports Postgres ready and continues

#### Scenario: Launch-time install self-heals a missing extension

- **WHEN** the launch-time gate runs, the container is reachable, but the `vector` extension is not yet installed
- **THEN** the gate runs `CREATE EXTENSION IF NOT EXISTS vector` (which installs it)
- **AND** on success the launch proceeds without surfacing the install as an error

#### Scenario: Extension install fails because extension files are absent

- **WHEN** `CREATE EXTENSION IF NOT EXISTS vector` fails because the pgvector files are not present
- **THEN** the gate aborts with an error naming the missing `vector` extension and a recovery path (`inflexa setup --force`)

### Requirement: `inflexa setup` provisions Postgres alongside the proxy

`inflexa setup` SHALL provision Postgres as a step after the existing proxy provisioning step. Setup SHALL prompt for Postgres credentials before provisioning. The existing `--force` flag SHALL also re-pull the Postgres image. The existing `--no-start` flag SHALL also skip starting containers. A new `--no-postgres` flag SHALL skip the Postgres step entirely. Setup SHALL print a combined next-steps message naming both the proxy URL and the Postgres connection string.

#### Scenario: Default setup provisions proxy then Postgres

- **WHEN** `inflexa setup` runs with no flags
- **THEN** the proxy is configured first, then the user is prompted for Postgres credentials, then `compose up -d` starts both services, then a next-steps message naming both endpoints is printed

#### Scenario: `--force` re-pulls both images

- **WHEN** `inflexa setup --force` runs
- **THEN** both images are re-pulled via `compose pull` even if cached

#### Scenario: `--no-start` skips container starts

- **WHEN** `inflexa setup --no-start` runs
- **THEN** images are pulled and configs written but `compose up -d` is not run

#### Scenario: `--no-postgres` skips only the Postgres step

- **WHEN** `inflexa setup --no-postgres` runs
- **THEN** the proxy is provisioned normally and the Postgres step is skipped

### Requirement: Progress feedback during provisioning

Every provisioning step SHALL surface a clear progress message so the user is never waiting in silence. During `inflexa setup`, progress SHALL use `@clack/prompts` spinners. During the launch-time gate (where the TUI isn't up yet), progress SHALL use plain `console.log` lines.

#### Scenario: Image pull shows progress

- **WHEN** the CLI pulls the `pgvector/pgvector:pg18` image
- **THEN** a visible progress indicator shows the pull is in progress (not silent)

#### Scenario: Container start shows progress

- **WHEN** the CLI starts containers via `compose up -d`
- **THEN** a "Starting containers…" message is shown before the command runs

#### Scenario: Readiness wait shows progress

- **WHEN** the CLI waits for `pg_isready` to succeed
- **THEN** a "Waiting for Postgres to be ready…" message is shown

### Requirement: Launch-time gate self-heals the Postgres substrate

A launch-time function SHALL run before any code path that integrates the harness. The gate is self-healing: when the substrate is missing or stopped, the gate SHALL provision it transparently so a first-time user running `inflexa` reaches a working Postgres without an explicit setup step. The gate SHALL generate the compose file if needed, run `compose up -d`, wait for `pg_isready`, and run the pgvector self-install. The gate SHALL surface progress messages while it works. The gate SHALL only exit non-zero when self-healing itself fails — and the error SHALL name the failing step, the active runtime, and the recovery path. The gate SHALL NOT surface a "please run `inflexa setup`" message for any recoverable condition.

#### Scenario: First launch with no containers auto-provisions

- **WHEN** the launch-time gate runs, no compose file or containers exist, and the runtime is ready
- **THEN** the gate generates the compose file with default credentials, runs `compose up -d` (showing progress), waits for `pg_isready`, runs the vector self-install, and proceeds
- **AND** no `inflexa setup` invocation was required

#### Scenario: Stopped containers are auto-started

- **WHEN** the launch-time gate runs and containers exist but are stopped
- **THEN** the gate runs `compose up -d` (which starts them), waits for ready, runs the vector self-install, and proceeds

#### Scenario: Ready containers proceed without side effects

- **WHEN** the launch-time gate runs and containers are already running
- **THEN** the gate runs the vector self-install (a no-op when already present) and proceeds without restarting

#### Scenario: Runtime not ready exits with actionable error

- **WHEN** the launch-time gate runs and the runtime's binary is missing or its daemon is down
- **THEN** the CLI prints the runtime-specific actionable error and exits non-zero

### Requirement: Container lifecycle outlives a CLI session

The containers SHALL be configured with `restart: unless-stopped` in the compose file, so they outlive any single CLI invocation. The CLI SHALL NOT stop containers on shutdown; the user stops them via `docker compose -f <path> down`.

#### Scenario: Second launch skips recreate

- **WHEN** a second CLI launch runs the readiness gate and containers are already running
- **THEN** no recreate is attempted and launch proceeds

#### Scenario: Stopped containers are auto-started by the gate

- **WHEN** the user runs `docker compose -f <path> stop` and then runs a CLI command
- **THEN** the gate auto-starts the containers via `compose up -d` and proceeds

### Requirement: Module rename — `modules/proxy/` → `modules/infra/`

The setup orchestrator module SHALL be renamed from `modules/proxy/` to `modules/infra/` to reflect its multi-service scope. All importers SHALL be updated. The `inflexa setup` command SHALL continue to work identically.

#### Scenario: Existing setup command works after rename

- **WHEN** a user runs `inflexa setup` after the module rename
- **THEN** the command works identically to before the rename

### Requirement: Settings TUI exposes Postgres fields

The settings TUI SHALL expose a Postgres section covering `host`, `port`, `database`, `user`, `password`, persisting edits to `config.json` via the existing `writeConfig` path. Every field SHALL be visible in clear text and editable — the password is a local connection credential, not a secret to hide. There SHALL be no `mode` or `image` fields. Existing settings sections SHALL remain unchanged.

#### Scenario: Editing a field persists to config

- **WHEN** the user edits `postgres.port` to `5433` in settings and saves
- **THEN** the value is written to `config.json` and is the resolved port on the next launch

#### Scenario: Password field is shown in clear text

- **WHEN** the settings screen renders the `postgres.password` field
- **THEN** the value is displayed in clear text, not masked

### Requirement: Paths appear in the help table

The `--help` output SHALL list the Postgres data directory and the compose file path in its Paths/Environment table, alongside the existing proxy paths.

#### Scenario: Postgres data dir surfaced in help

- **WHEN** the user runs `inflexa --help`
- **THEN** the Paths table contains a row for the Postgres data directory

#### Scenario: Compose file path surfaced in help

- **WHEN** the user runs `inflexa --help`
- **THEN** the Paths table contains a row for the Docker Compose file

### Requirement: `inflexa up` starts the infrastructure containers

`inflexa up` SHALL start all compose-managed containers (proxy + Postgres), generating the compose file if it doesn't exist. It is the user-initiated equivalent of the self-healing launch-time gate. The command SHALL be idempotent — already-running containers are left untouched.

#### Scenario: Start containers from a clean state

- **WHEN** `inflexa up` runs and no containers are running
- **THEN** the compose file is generated (if missing) and `compose up -d` starts both services
- **AND** the command prints the proxy URL and Postgres port

#### Scenario: Containers already running

- **WHEN** `inflexa up` runs and both containers are already running
- **THEN** the command completes without restarting anything

### Requirement: `inflexa down` stops the infrastructure containers

`inflexa down` SHALL stop and remove all compose-managed containers and the shared network. With `--delete-data`, it SHALL also delete the Postgres data directory and the proxy credentials directory, but only after the user types exactly "I understand" at a confirmation prompt (via `@clack/prompts`). Non-interactive terminals SHALL decline the destructive confirmation.

#### Scenario: Stop containers

- **WHEN** `inflexa down` runs
- **THEN** `compose down` stops both containers and removes the shared network
- **AND** the command prints guidance to restart with `inflexa up`

#### Scenario: Delete data with confirmation

- **WHEN** `inflexa down --delete-data` runs and the user types "I understand"
- **THEN** the containers are stopped, the Postgres data directory is deleted, and the proxy credentials directory is deleted
- **AND** the command prints guidance to re-setup with `inflexa setup`

#### Scenario: Delete data rejected

- **WHEN** `inflexa down --delete-data` runs and the user types anything other than "I understand" or cancels
- **THEN** no data is deleted and the command prints "Aborted"

#### Scenario: Non-interactive terminal declines destructive confirmation

- **WHEN** `inflexa down --delete-data` runs on a non-TTY
- **THEN** the destructive confirmation fails (promptText requires TTY) and no data is deleted

### Requirement: Container names are environment-aware

Container and network names SHALL use a `inflexa-` prefix in production builds and `inflexa-dev-` in dev runs (`NODE_ENV !== "production"`). This prevents a developer's `bun run dev` containers from colliding with a user's installed binary's containers on the same machine.

#### Scenario: Dev container names

- **WHEN** the CLI runs in dev mode (`NODE_ENV !== "production"`)
- **THEN** container names are `inflexa-dev-cliproxy` and `inflexa-dev-postgres`, and the network is `inflexa-dev`

#### Scenario: Production container names

- **WHEN** the CLI runs as a compiled binary (`NODE_ENV === "production"`)
- **THEN** container names are `inflexa-cliproxy` and `inflexa-postgres`, and the network is `inflexa`

### Requirement: pgvector install retries on transient connection failures

The `CREATE EXTENSION IF NOT EXISTS vector` statement SHALL retry on transient connection failures (e.g. the PG Docker entrypoint's init-phase fast shutdown killing the connection). Permanent failures (missing extension files, privilege denied) SHALL fail immediately with an actionable error. The retry loop SHALL have a bounded timeout (30s).

#### Scenario: Init-phase race absorbed by retry

- **WHEN** the first `CREATE EXTENSION` attempt hits the init-phase fast shutdown
- **THEN** the CLI retries after a short interval and succeeds when the real server starts

#### Scenario: Missing extension files fail immediately

- **WHEN** `CREATE EXTENSION` fails because pgvector files are absent
- **THEN** the CLI does NOT retry and exits with an actionable error naming the image
