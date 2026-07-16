## ADDED Requirements

### Requirement: Sandbox engine connection follows the pinned container runtime

The harness boot SHALL resolve the pinned container runtime's sandbox-engine
socket (via the container-runtime resolution) before constructing the sandbox
client, and SHALL pass it to `createSandboxClient` as `engineSocketPath`. When
the pinned runtime is podman, boot SHALL additionally pass
`stepTreeAccess: "world-writable"` — podman machine's virtiofs preserves host
ownership honestly, so the uid-1000 sandbox workload needs world-write on the
pre-created step tree; a docker pin SHALL NOT pass it, keeping today's modes
under Docker Desktop's permissive sharing layer. A docker pin SHALL pass no
socket path, preserving dockerode's default resolution byte-for-byte. Image
pre-pull (`ensureSandboxImage`) and container create then target the same
engine by construction. A failed socket resolution SHALL fail boot with a
dedicated, user-actionable error variant before any side effect — never a
dockerode connection error surfacing mid-run.

#### Scenario: Podman pin wires the compat socket and step-tree access

- **WHEN** the runtime boots with `podman` pinned and a resolvable compat socket
- **THEN** `createSandboxClient` receives that socket as `engineSocketPath` and `stepTreeAccess: "world-writable"`
- **AND** sandbox containers are created on the same engine that pre-pulled the image

#### Scenario: Docker pin is byte-identical to today

- **WHEN** the runtime boots with `docker` pinned
- **THEN** `createSandboxClient` receives no `engineSocketPath` and no `stepTreeAccess`

#### Scenario: Unresolvable podman socket blocks boot with actionable guidance

- **WHEN** the runtime boots with `podman` pinned and the socket cannot be resolved
- **THEN** boot fails with the resolution's runtime-specific message (start the machine / enable the socket service) and DBOS is not launched
