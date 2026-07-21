# docker-sandbox-provider — delta

## ADDED Requirements

### Requirement: Transport-mode container wiring

`createSandbox` SHALL render the harness `SandboxTransport` into the container's
runtime configuration:

- It SHALL pass `SANDBOX_TRANSPORT` (`poll` | `callback`) into the container env in
  both modes, and pass `SANDBOX_CALLBACK_SECRET` in both modes.
- In **poll mode** it SHALL create the container on the default bridge with
  `CapAdd: ["NET_ADMIN"]` and set the Docker-poll firewall env flag, so the image's
  root entrypoint installs the egress-deny firewall and then de-privileges to the
  workload uid. It SHALL NOT set `CORTEX_BASE_URL`.
- In **callback mode** it SHALL set `CORTEX_BASE_URL` to the host callback ingress,
  SHALL NOT add `NET_ADMIN`, and SHALL NOT set the firewall flag (egress is
  permitted); no `--internal` network and no gateway sidecar are created.

The workload posture SHALL be otherwise unchanged (uid 1000, `no-new-privileges`);
`NET_ADMIN` is added only so the root entrypoint can install the firewall and is
dropped before the workload runs.

#### Scenario: Poll mode adds the egress firewall

- **GIVEN** the transport is `poll`
- **WHEN** `createSandbox` creates the container
- **THEN** the container env SHALL carry `SANDBOX_TRANSPORT=poll` and the firewall flag
- **AND** the `HostConfig` SHALL add `NET_ADMIN`
- **AND** no `CORTEX_BASE_URL` SHALL be set

#### Scenario: Callback mode permits egress with no gateway

- **GIVEN** the transport is `callback`
- **WHEN** `createSandbox` creates the container
- **THEN** the container env SHALL carry `SANDBOX_TRANSPORT=callback` and `CORTEX_BASE_URL`
- **AND** the `HostConfig` SHALL NOT add `NET_ADMIN` and SHALL NOT set the firewall flag
- **AND** no `--internal` network and no gateway container SHALL be created

## MODIFIED Requirements

### Requirement: Dynamic port mapping for host connectivity

The Docker backend SHALL use dynamic port mapping for `8765/tcp` bound to the
loopback host address (`HostIp: "127.0.0.1"`, `HostPort: ""` so Docker assigns a
free port), so the sandbox exec port is reachable from the host but not published on
any other host interface. The mapped port SHALL be retrieved after container start
via the Docker API. All HTTP communication with sandbox-server (health, submit, and
poll) SHALL use `127.0.0.1:{mappedPort}`.

#### Scenario: Exec port is published to loopback only

- **WHEN** the container is created
- **THEN** `8765/tcp` SHALL be bound with `HostIp: "127.0.0.1"` and a dynamically assigned host port
- **AND** the port SHALL NOT be published on `0.0.0.0`

#### Scenario: Parallel sandboxes get unique ports

- **WHEN** two sandboxes start concurrently
- **THEN** each gets a different host port
- **AND** both can be submitted to and polled independently
