## MODIFIED Requirements

### Requirement: The reference store is a read-only mount at /mnt/refs

When a reference store is configured, the sandbox container SHALL receive it as a
**read-only** mount at `/mnt/refs`. The Docker backend SHALL evaluate the host
directory named by `refStorePath` at **each sandbox creation** — never from a
snapshot taken at embedder boot — and SHALL bind-mount it iff the path is, at
that moment, a real directory (symlinks rejected: the bind authority must itself
be the store, not an indirection). The Docker backend SHALL NOT create a bind
whose host source is missing, since the engine would auto-create a root-owned
directory at that path. A `refStorePath` that does not name a real directory at
creation time SHALL be treated as "no store yet" — a normal cold state, skipped
without a warning (deliberately unlike the lib store's missing-store path, which
is a degradation and warns). The Kubernetes backend SHALL mount the PVC named by
`refStorePvc`. When neither is configured, the container SHALL receive no
`/mnt/refs` mount.

#### Scenario: Docker bind-mounts the host ref store read-only

- **GIVEN** `refStorePath` is set and names an existing host directory
- **WHEN** a Docker sandbox is created
- **THEN** the container has a read-only bind of that directory at `/mnt/refs`

#### Scenario: A store installed mid-session is visible to the next sandbox

- **GIVEN** `refStorePath` is set but the directory does not exist when the embedder boots
- **WHEN** the directory is created (e.g. a reference download completes) and a Docker sandbox is created afterwards
- **THEN** the container has a read-only bind of that directory at `/mnt/refs`, without any runtime restart

#### Scenario: A missing store is skipped without side effects

- **GIVEN** `refStorePath` is set but the directory does not exist at sandbox creation
- **WHEN** a Docker sandbox is created
- **THEN** the container has no `/mnt/refs` mount, no directory is created at `refStorePath`, and no warning is logged

#### Scenario: A symlinked store path is not a bind authority

- **GIVEN** `refStorePath` names a symlink (even one resolving to a directory)
- **WHEN** a Docker sandbox is created
- **THEN** the container has no `/mnt/refs` mount

#### Scenario: Kubernetes mounts the ref-store PVC read-only

- **GIVEN** `refStorePvc` is set
- **WHEN** a sandbox pod spec is built
- **THEN** the pod mounts that PVC read-only at `/mnt/refs`

#### Scenario: No ref store configured

- **GIVEN** neither `refStorePath` nor `refStorePvc` is set
- **WHEN** a sandbox is created
- **THEN** the container has no `/mnt/refs` mount
