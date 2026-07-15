## MODIFIED Requirements

### Requirement: Launch-time gate self-heals the Postgres substrate

A launch-time function SHALL run before any code path that integrates the harness. The gate is self-healing: when the substrate is missing or stopped, the gate SHALL provision it transparently. The gate SHALL generate the compose file if needed, ensure every bind-mount source exists with the correct type (per the infra-state-resilience mount-source integrity requirement), run `compose up -d`, wait for `pg_isready`, and run the pgvector self-install (with retry). The gate SHALL surface progress messages while it works. The gate SHALL only exit non-zero when self-healing itself fails.

#### Scenario: First launch with no containers auto-provisions

- **WHEN** the launch-time gate runs, no compose file or containers exist, and the runtime is ready
- **THEN** the gate generates the compose file with default credentials, ensures the mount sources, runs `compose up -d`, waits for `pg_isready`, runs the vector self-install, and proceeds

#### Scenario: Stopped containers are auto-started

- **WHEN** the launch-time gate runs and containers exist but are stopped
- **THEN** the gate runs `compose up -d`, waits for ready, runs the vector self-install, and proceeds

#### Scenario: Ready containers proceed without side effects

- **WHEN** the launch-time gate runs and containers are already running
- **THEN** the gate runs the vector self-install (a no-op when already present) and proceeds without restarting

### Requirement: `inflexa up` starts the infrastructure containers

`inflexa up` SHALL start all compose-managed containers, generating the compose file if it doesn't exist. It is the user-initiated equivalent of the self-healing launch-time gate, and SHALL provision the same preconditions the gate does before composing: in cliproxy mode the proxy config file exists before the engine is invoked, and every bind-mount source exists with the correct type (per the infra-state-resilience mount-source integrity requirement). The command SHALL be idempotent.

#### Scenario: Start containers from a clean state

- **WHEN** `inflexa up` runs and no containers are running
- **THEN** the compose file is generated (if missing) and `compose up -d` starts both services
- **AND** the command prints the proxy URL and Postgres port

#### Scenario: `up` with no proxy config provisions it first

- **WHEN** `inflexa up` runs in cliproxy mode and the proxy config file does not exist
- **THEN** the proxy config is written before `compose up -d`, and no directory is manufactured at the config file's path
