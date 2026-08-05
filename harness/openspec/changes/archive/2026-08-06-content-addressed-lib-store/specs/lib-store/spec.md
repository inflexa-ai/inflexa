## MODIFIED Requirements

### Requirement: The library store is a read-only mount at /mnt/libs

When a library store is configured, the sandbox container SHALL receive it as a
**read-only** mount at `/mnt/libs`, with the active version at
`/mnt/libs/current`. The Docker backend SHALL bind-mount the host directory named
by `libStorePath`; the Kubernetes backend SHALL mount the PVC named by
`libStorePvc`. When neither is configured, the container SHALL receive no
`/mnt/libs` mount and no lib-store env.

The store root MAY hold, in addition to `current`, a content-addressed package
directory at `/mnt/libs/store` and one or more per-analysis farms under
`/mnt/libs/farms`, with `current` resolving to the active farm. A farm SHALL
present the same interior layout as a baked store, so the resolver env and the
Python `.pth` retain their meaning whichever way the store was assembled. Because
the whole store root is a single mount, farm links into `/mnt/libs/store` SHALL
resolve without an additional mount.

#### Scenario: Docker bind-mounts the host lib store read-only

- **GIVEN** `libStorePath` is set to a host directory
- **WHEN** a Docker sandbox is created
- **THEN** the container has a read-only bind of that directory at `/mnt/libs`

#### Scenario: Kubernetes mounts the lib-store PVC read-only

- **GIVEN** `libStorePvc` is set
- **WHEN** a sandbox pod spec is built
- **THEN** the pod mounts that PVC read-only at `/mnt/libs`

#### Scenario: No lib store configured

- **GIVEN** neither `libStorePath` nor `libStorePvc` is set
- **WHEN** a sandbox is created
- **THEN** the container has no `/mnt/libs` mount and no lib-store env vars

#### Scenario: A farm resolves through the store mount

- **GIVEN** a store root whose `current` resolves to a farm of symbolic links into `/mnt/libs/store`
- **WHEN** a sandbox is created against it
- **THEN** imports resolve through the farm with no mount beyond `/mnt/libs`

#### Scenario: A baked store and a farm are indistinguishable to the runtime

- **GIVEN** two stores holding the same package set, one baked and one assembled as a farm
- **WHEN** a sandbox resolves an import in each
- **THEN** the resolved module and its version are the same in both

## REMOVED Requirements

### Requirement: No runtime package installation

**Reason**: The requirement conflated two separate claims — that the sandbox cannot reach a network, and that the package set cannot change. Only the first is a security property. Provisioning now runs in a separate, short-lived container that never mounts user data, so the package set can change between steps while the sandbox itself remains without a network and its mount remains read-only. Keeping the requirement would forbid a capability that does not weaken the containment boundary.

**Migration**: Replaced by "Package installation is host-mediated and never reaches the sandbox" below, which retains the operative guarantees: the sandbox has no egress, the mount stays read-only, and an agent still discovers packages through `list_available_packages` rather than assuming them. Agent-facing text asserting that installation is impossible — the `packages.txt` header, the `list_available_packages` tool description, and the sandbox standards prompt — must be updated to describe provisioning as a host action rather than as impossible. Sandbox steps still SHALL NOT install packages themselves; nothing an agent can run inside a sandbox gains a new capability.

## ADDED Requirements

### Requirement: Package installation is host-mediated and never reaches the sandbox

A sandbox step SHALL NOT install packages. The library store SHALL remain read-only to the sandbox and the sandbox SHALL retain no network egress. Any change to the package set SHALL be performed by the host, outside the sandbox, and SHALL take effect only for sandboxes created after it.

Sandbox agent instructions SHALL direct agents to call `list_available_packages` before importing a package they are not certain is staged, narrowed to the packages they actually intend to import. The lookup is targeted and conditional — a catalog dump up front is exactly what it is not. Those instructions SHALL state that the agent cannot install a package itself, and SHALL NOT state that the environment is unchangeable.

#### Scenario: The sandbox cannot install a package

- **GIVEN** a running sandbox step
- **WHEN** it attempts to install a package
- **THEN** the attempt fails, because there is no egress and the store mount is read-only

#### Scenario: Sandbox standards describe discovery and the real limit

- **GIVEN** the shared sandbox-agent standards prompt
- **THEN** it directs the agent to look a package up with `list_available_packages` before importing one it is not certain is present, and states that the agent cannot install one itself

#### Scenario: A provisioned package appears in the next sandbox

- **GIVEN** a store to which the host has added a package
- **WHEN** a new sandbox is created against that store
- **THEN** the package is importable and appears in `list_available_packages`

#### Scenario: A running sandbox does not observe a store change

- **GIVEN** a running sandbox
- **WHEN** the host adds a package to the store
- **THEN** the running sandbox's view is unchanged
