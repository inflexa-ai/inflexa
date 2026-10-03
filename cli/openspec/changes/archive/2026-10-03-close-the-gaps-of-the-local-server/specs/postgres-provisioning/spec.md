## MODIFIED Requirements

### Requirement: `inflexa up` starts the infrastructure containers

`inflexa up` MUST run the gate of the server boot (`ensureProxyReady`), with the login prompt on a terminal. In cliproxy mode, the gate writes the proxy config before the engine runs. Then it signs in when no credential exists. The gate MUST then generate the compose file for the connection mode, pull the missing images, and start each compose-managed container. Each bind-mount source MUST exist with the correct type before the compose step, per the mount-source integrity requirement of infra-state-resilience. In cliproxy mode, the gate then probes the live credential, and on a terminal it offers the re-login, per `cliproxy-credential-health`.

The command MUST be idempotent. A failure MUST print the reason and exit with code 1. After a success, the command MUST print the proxy URL and the Postgres port, and ask a failed server to boot again, per `local-server`.

#### Scenario: Start containers from a clean state

- **WHEN** `inflexa up` runs and no containers are running
- **THEN** the compose file is generated (if missing) and `compose up -d` starts both services
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
