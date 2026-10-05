## ADDED Requirements

### Requirement: The container confines its own egress

`createSandbox` MUST start each container as root on the default bridge, with
`CapAdd: ["NET_ADMIN", "SETUID", "SETGID", "SETPCAP"]` and the firewall env
flag. Thus the root entrypoint of the image installs the egress-deny firewall,
and then it drops to the workload uid. The container env MUST NOT carry
`SANDBOX_TRANSPORT`, `CORTEX_BASE_URL`, or a secret. The backend MUST make no
`--internal` network and no gateway container.

Each added capability exists only for the privileged setup of the root
entrypoint:

- `NET_ADMIN` installs the firewall rules.
- `SETUID` and `SETGID` let `setpriv` drop to the workload uid and gid.
- `SETPCAP` clears the bounding set.

The entrypoint MUST drop each of them before the workload runs. Thus the
capability sets of the workload are empty. The workload runs as uid 1000 with
`no-new-privileges`.

#### Scenario: Each container gets the egress firewall

- **WHEN** `createSandbox` makes the container
- **THEN** the container env carries the firewall flag
- **AND** the `HostConfig` adds exactly `NET_ADMIN`, `SETUID`, `SETGID`, and `SETPCAP`

#### Scenario: The container gets no transport, no callback URL, and no secret

- **WHEN** `createSandbox` makes the container
- **THEN** the container env carries no `SANDBOX_TRANSPORT`, no `CORTEX_BASE_URL`, and no `SANDBOX_CALLBACK_SECRET`
- **AND** the backend makes no `--internal` network and no gateway container

## MODIFIED Requirements

### Requirement: createDockerSandboxOps implements the backend ops

`createDockerSandboxOps` MUST produce the backend-specific ops (`createSandbox`,
`teardown`, `teardownById`, `isAlive`, `listManagedSandboxes`) that
`createSandboxClient` (`harness/src/sandbox/create-sandbox.ts`) consumes. The
exec is backend-agnostic: Docker and K8s share the same submit and poll
contract. Each op MUST return a `ResultAsync` that carries a `SandboxError`
variant on failure, and it MUST NOT throw.

#### Scenario: Backend selection routes to Docker in dev

- **GIVEN** `SANDBOX_BACKEND=docker`
- **WHEN** `createSandboxClient(...)` is constructed
- **THEN** the returned client wires `createDockerSandboxOps` for the sandbox spawn and the teardown
- **AND** `exec` is used with no change across backends

## REMOVED Requirements

### Requirement: Transport-mode container wiring

**Reason**: The transport is removed. Each Docker container gets the egress firewall, and no container gets a callback URL or a secret.

**Migration**: Refer to "The container confines its own egress". Remove `transport` and `cortexBaseUrl` from the Docker client config.
