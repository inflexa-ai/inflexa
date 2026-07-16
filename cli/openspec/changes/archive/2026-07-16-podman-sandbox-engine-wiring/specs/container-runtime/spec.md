## ADDED Requirements

### Requirement: Per-runtime sandbox-engine socket resolution

The runtime descriptor surface SHALL resolve the Docker-API socket the embedded
harness dials for sandbox containers, per runtime and per platform, through the
descriptor rather than call-site conditionals. Docker SHALL resolve to no
socket (the harness then uses dockerode's default resolution, preserving
`DOCKER_HOST`). Podman SHALL resolve the Docker-compat socket: on macOS via
`podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}'`; on
Linux via `podman info --format '{{.Host.RemoteSocket.Path}}'` gated on the
returned path existing, because a reachable podman CLI does not imply a
listening REST socket. Resolution SHALL run at each boot and SHALL NOT be
persisted — the macOS socket lives under `$TMPDIR` and moves across machine
restarts. A failed resolution SHALL return a runtime-specific actionable error
(`podman machine start` on macOS; `systemctl --user enable --now podman.socket`
on Linux). The probe SHALL be injectable for tests, mirroring `ensureReady`.

#### Scenario: Docker resolves to default engine resolution

- **WHEN** the pinned runtime is `docker` and the sandbox engine socket is resolved
- **THEN** no socket path is returned and the harness client uses dockerode's default resolution

#### Scenario: Podman on macOS resolves the machine's compat socket

- **WHEN** the pinned runtime is `podman` on macOS with a running machine
- **THEN** the machine's `ConnectionInfo.PodmanSocket.Path` is returned as the engine socket

#### Scenario: Podman on Linux requires the REST socket to exist

- **WHEN** the pinned runtime is `podman` on Linux and `podman info` reports a socket path that does not exist on disk
- **THEN** resolution fails with a message hinting `systemctl --user enable --now podman.socket`

#### Scenario: Stopped podman machine is an actionable failure

- **WHEN** the pinned runtime is `podman` on macOS and the machine is not running
- **THEN** resolution fails with a message hinting `podman machine start`
