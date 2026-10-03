## MODIFIED Requirements

### Requirement: Postgres is provisioned via Docker Compose alongside the proxy

The CLI SHALL manage both CLIProxyAPI and Postgres as services in a single Docker Compose file, generated into the CLI's data dir. Both services SHALL share a network so inter-container communication uses service names rather than host port mapping. The Postgres service SHALL publish the configured port to `localhost` and SHALL persist its data at `/var/lib/postgresql` (the PG 18+ parent mount). On a host that is not Windows, the persistence MUST be a bind mount of the Postgres data directory of the CLI. On a Windows host, the persistence MUST be a named volume of the container engine. The compose file MUST declare that volume with an explicit name. The file share between a Windows host and the Linux machine of the engine refuses `chmod`, and `initdb` cannot start on such a mount. One function MUST give the location of the Postgres data, and the compose template, the mount manifest, and the `--delete-data` prompt MUST all read it.

Both service images SHALL be pinned by version tag AND manifest digest (`<name>:<tag>@sha256:<digest>`), and NEITHER is user-overridable: the proxy as `eceasy/cli-proxy-api:v7.2.148@sha256:150195d92f3a26459f61e06f36f4f6f6312f267d5a43e4df5629d67369bc672d`, Postgres as `pgvector/pgvector:0.8.5-pg18@sha256:12a379b47ad65289572ea0756efc11b7c241a6662833e8af7038cd3b73d647e0`. A floating tag (`latest`, a bare major like `pg18`) SHALL NOT appear in the generated compose file: the launch gate's credential classifications are calibrated against verified proxy behavior, and an upstream push must never change that behavior under an unchanged install — the digest additionally makes a republished tag inert. Bumping a pin is a deliberate code change whose procedure (update tag+digest together, re-verify the launch-gate calibration points) is documented at the pin site.

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

#### Scenario: A Windows host keeps the Postgres data in a named volume

- **WHEN** the compose file is generated on a Windows host, in any mode
- **THEN** the Postgres service mounts the named volume at `/var/lib/postgresql`
- **AND** the file has a top-level `volumes:` block that declares the volume with an explicit `name:`
- **AND** no line of the file bind-mounts the Postgres data directory

#### Scenario: A host that is not Windows keeps the bind mount

- **WHEN** the compose file is generated on a macOS host or a Linux host
- **THEN** the Postgres service bind-mounts the Postgres data directory at `/var/lib/postgresql`
- **AND** the file has no top-level `volumes:` block

### Requirement: Container names are environment-aware

The ENTIRE stack identity SHALL be environment-aware, determined by `env.isDevelopment` (derived from the baked `INFLEXA_BUILD_CHANNEL` — `isDevelopment` is true unless the `production` channel was baked in, never keyed on `NODE_ENV`): container and network names (`inflexa-` prefix in production, `inflexa-dev-` in dev), the published host ports (production: proxy 8317, postgres default 8432; dev: proxy 8318, postgres default 8434), the generated compose file path, the host-side mount sources (the CLIProxyAPI config + credential dir and the Postgres data dir), and the name of the Postgres volume of a Windows host (`inflexa-postgres-data` in production, `inflexa-dev-postgres-data` in dev). The adjacent harness DBOS admin port — the host HTTP listener the harness runtime binds, not a published container port — SHALL be channel-aware on the same signal (production 8433, dev 8435), so the simultaneity guarantee holds across every host listener a channel binds, not only the two container-published ports. Production paths and ports SHALL be identical to their historical values, so existing installs are untouched. This prevents a developer's `bun run dev` stack from colliding with an installed binary's stack in ANY shared resource: a port bind, a compose file one build regenerates against the other, a Postgres data dir, or — most dangerously — a shared provider credential file, which two independently-refreshing proxies would corrupt through OAuth refresh-token rotation. Under each channel's defaults — and under any explicit override the user picks that does not itself collide — the two stacks SHALL be able to run simultaneously. The one exception is by design: an explicitly persisted `postgres.port` applies to BOTH channels (per the per-field override contract) and so reintroduces contention on that single port — a consequence the customizing user owns.

#### Scenario: Dev container names

- **WHEN** the CLI runs in dev mode
- **THEN** container names are `inflexa-dev-cliproxy` and `inflexa-dev-postgres`, and the network is `inflexa-dev`

#### Scenario: Production container names

- **WHEN** the CLI runs as a compiled binary
- **THEN** container names are `inflexa-cliproxy` and `inflexa-postgres`, and the network is `inflexa`

#### Scenario: Dev and production stacks run simultaneously

- **WHEN** an installed binary's stack is up and `bun run dev` brings up the dev stack, with no `postgres.port` persisted to the shared `config.json` (each channel resolving its own default port)
- **THEN** both stacks run concurrently — no port contention, and neither reads nor writes the other's compose file, proxy config, credential dir, or Postgres data dir

#### Scenario: The Postgres volume of a Windows host is channel-aware

- **WHEN** the compose file is generated on a Windows host in dev mode
- **THEN** the name of the Postgres volume is `inflexa-dev-postgres-data`
- **AND** a production build on the same host uses `inflexa-postgres-data`, thus the two stacks share no Postgres data

#### Scenario: Production paths and ports are unchanged

- **WHEN** the CLI runs as a compiled binary after this change
- **THEN** every stack path and published port is byte-identical to its pre-change value, and existing containers, credentials, and data are picked up as-is

#### Scenario: A dev stack never touches the production credential

- **WHEN** the dev launch gate needs a provider credential and only the production credential dir holds one
- **THEN** the dev flow treats itself as not authenticated and drives its own sign-in into the dev credential dir, leaving the production credential file unread and unwritten

### Requirement: `inflexa down` stops the infrastructure containers

`inflexa down` SHALL stop and remove all compose-managed containers and the shared network. With `--delete-data`, it SHALL also delete the Postgres data directory and the proxy credentials directory, but only after the user types exactly "I understand" at a confirmation prompt. Non-interactive terminals SHALL decline the destructive confirmation.

With `--delete-data`, the command MUST also remove the named Postgres volume when the engine has one. It MUST address the volume by its explicit name through the engine, after the containers are gone. It MUST NOT read the compose file to find the volume, because `inflexa down` never writes that file.

An absent volume is a normal condition, and it MUST NOT give an error. If the engine refuses to remove the volume, the command MUST print a warning with the text of the engine, and then it MUST continue. The confirmation prompt MUST name the location that holds the Postgres data on this host: the data directory, or the named volume.

#### Scenario: Stop containers

- **WHEN** `inflexa down` runs
- **THEN** `compose down` stops both containers and removes the shared network

#### Scenario: Delete data with confirmation

- **WHEN** `inflexa down --delete-data` runs and the user types "I understand"
- **THEN** the containers are stopped, the Postgres data directory is deleted, and the proxy credentials directory is deleted

#### Scenario: Delete data rejected

- **WHEN** `inflexa down --delete-data` runs and the user does NOT type "I understand"
- **THEN** no data is deleted and the command aborts

#### Scenario: Delete data removes the named volume of a Windows host

- **WHEN** `inflexa down --delete-data` runs on a Windows host, the user types "I understand", and the engine holds the named Postgres volume
- **THEN** the containers stop first, and then the engine removes the volume by its explicit name
- **AND** the confirmation prompt named the volume, not a directory, as the location of the Postgres data

#### Scenario: An absent volume is not an error

- **WHEN** `inflexa down --delete-data` runs with confirmation and the engine holds no named Postgres volume
- **THEN** the command prints no warning about the volume, and it completes

#### Scenario: A volume that the engine refuses to remove gives a warning

- **WHEN** `inflexa down --delete-data` runs with confirmation and the engine refuses to remove the volume
- **THEN** the command prints a warning that carries the text of the engine, and it continues with the other deletions

### Requirement: Paths appear in the help table

The `--help` output SHALL list the Postgres data directory and the compose file path in its Paths/Environment table, alongside the existing proxy paths. On a Windows host, the description of the Postgres data directory row MUST say that the directory is not in use. It MUST also say that a named volume of the container engine holds the data.

#### Scenario: Postgres data dir surfaced in help

- **WHEN** the user runs `inflexa --help`
- **THEN** the Paths table contains rows for the Postgres data directory and the Docker Compose file

#### Scenario: The row tells the truth on a Windows host

- **WHEN** the user runs `inflexa --help` on a Windows host
- **THEN** the description of the Postgres data directory row says that a named volume of the container engine holds the data

## ADDED Requirements

### Requirement: The compose file is valid YAML for each host path

The compose template MUST escape each host path that it writes into a double-quoted YAML scalar. The escape MUST double each backslash, and it MUST escape each quotation mark. Thus a YAML parser gives back the exact host path. This applies to each bind-mount source in each connection mode. A path of a Windows host always holds a backslash, thus a path that the template does not escape stops each Windows install.

#### Scenario: A Windows path gives a valid file

- **WHEN** the compose file is generated in cliproxy mode with the proxy config path `C:\Users\dana\AppData\Local\inflexa\cliproxy\config.yaml`
- **THEN** each backslash of the path is doubled in the volume line
- **AND** a YAML parser reads the scalar back as the exact path, followed by `:` and the container path

#### Scenario: A quotation mark in a path gives a valid file

- **WHEN** the compose file is generated with a host path that holds a `"` character
- **THEN** the volume line escapes the character, and the scalar ends only at the last quotation mark of the line

#### Scenario: A POSIX path does not change

- **WHEN** the compose file is generated with host paths that hold no backslash and no quotation mark
- **THEN** each volume line is the same as it was before the escape

### Requirement: The readiness wait reports a restart loop

The readiness wait polls `pg_isready`, and each compose entry point that waits for Postgres shares it. After each poll that fails, the wait MUST read the restart count of the Postgres container from the engine. The first good read is the baseline. When a later read is 2 or more above the baseline, the wait MUST stop at once with a restart-loop error. It MUST NOT wait for the timeout.

A restart count from before the wait MUST NOT give the error. A container that restarted one time in the past can be healthy now. When the engine gives no restart count, the wait MUST ignore the read, and it MUST keep the timeout path.

The restart-loop error and the timeout error MUST both carry the last lines of the container log, from stdout and from stderr. Each of the two errors MUST also name the engine command that shows the full log. When the engine cannot give the log, the error MUST omit the lines, and it MUST keep the other text.

#### Scenario: A restart loop stops the wait before the timeout

- **WHEN** `pg_isready` fails on each poll, and the restart count of the container rises from 0 to 2 during the wait
- **THEN** the wait gives the restart-loop error at once, before the 30 seconds end
- **AND** the message carries the last lines of the container log, for example the `initdb` error

#### Scenario: A restart from the past gives no error

- **WHEN** the first read of the restart count is 5, the count does not rise, and `pg_isready` passes on a later poll
- **THEN** the wait gives success

#### Scenario: An engine with no restart count keeps the timeout

- **WHEN** each read of the restart count fails, and `pg_isready` fails for the full 30 seconds
- **THEN** the wait gives the timeout error, and the message carries the last lines of the container log

#### Scenario: A log that the engine cannot give does not hide the error

- **WHEN** the wait gives the restart-loop error or the timeout error, and the `logs` command of the engine fails
- **THEN** the message has no log lines, and it keeps the diagnosis and the command for the full log
