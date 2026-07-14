# lib-store Specification

## Purpose

The sandbox base image carries the R, Python, and Node.js runtimes but **no
analysis packages** — those live in a shared **library store** that is bind- or
volume-mounted **read-only** into every sandbox container at `/mnt/libs`, with
the active version surfaced at `/mnt/libs/current`. One immutable image plus an
externally-versioned package layer keeps the image small, lets the package set
roll forward without rebuilding the image, and makes a sandbox step physically
unable to install anything at runtime (there is no network and the mount is
read-only).

Agents never assume packages or paths. They discover what is installed through
the `list_available_packages` tool (`src/tools/sandbox/list-available-packages.ts`),
which reads `/mnt/libs/current/packages.txt`. When the store is mounted the
harness also injects the language-resolver env (`R_LIBS_SITE`, `NODE_PATH`,
`PATH` with the conda `bin`) so imports resolve against `/mnt/libs/current`
without per-script path wiring.

The store is supplied by the embedder: the Docker backend bind-mounts a host
directory (`libStorePath`), the Kubernetes backend mounts a read-only PVC
(`libStorePvc`). How that directory or PVC is *built and published* is owned by a
separate library-store build pipeline and is out of scope for the harness — this
spec describes only the runtime mount contract and the discovery surface.

## Requirements

### Requirement: The library store is a read-only mount at /mnt/libs

When a library store is configured, the sandbox container SHALL receive it as a
**read-only** mount at `/mnt/libs`, with the active version at
`/mnt/libs/current`. The Docker backend SHALL bind-mount the host directory named
by `libStorePath`; the Kubernetes backend SHALL mount the PVC named by
`libStorePvc`. When neither is configured, the container SHALL receive no
`/mnt/libs` mount and no lib-store env.

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

### Requirement: Packages are discoverable via the list_available_packages tool

The harness SHALL expose a `list_available_packages` tool (built with
`defineTool`) that reads `/mnt/libs/current/packages.txt` and returns its
contents. A missing or unmounted store is an expected state: the tool SHALL NOT
throw — it SHALL return an `available: false` data variant carrying a fallback
note rather than an error.

#### Scenario: Packages available

- **WHEN** `list_available_packages` is called and `/mnt/libs/current/packages.txt` is readable
- **THEN** it returns `{ available: true, content: "<packages.txt contents>" }`

#### Scenario: Store not mounted

- **WHEN** `list_available_packages` is called and the file cannot be read
- **THEN** it returns `{ available: false, content }` whose content advises that the library store may not be mounted, without throwing

### Requirement: The lib-store resolver env is injected only when the store is mounted

When the lib store is mounted, the mount plan SHALL emit the package-resolver
env so language runtimes resolve imports against `/mnt/libs/current`:
`R_LIBS_SITE` covering the github/bioconductor/cran subtrees, `NODE_PATH` at
`/mnt/libs/current/node/node_modules`, and `PATH` including
`/mnt/libs/current/conda/bin`. `PYTHONPATH` SHALL NOT be set — system Python
resolves the store via a `.pth` file. When the store is not mounted, none of
these vars SHALL be emitted.

#### Scenario: Resolver env present with the store mounted

- **GIVEN** the lib store is mounted
- **WHEN** the mount plan is built
- **THEN** `R_LIBS_SITE`, `NODE_PATH`, and a conda-`bin` `PATH` are emitted and `PYTHONPATH` is absent

### Requirement: No runtime package installation

The base image SHALL NOT bake in analysis packages, and sandbox steps SHALL NOT
install packages at runtime — only what the store surfaces is available. Sandbox
agent instructions SHALL direct agents to call `list_available_packages` before
importing a package they are not certain is staged, narrowed to the packages they
actually intend to import, and SHALL state that runtime installs are not possible.
The lookup is targeted and conditional — a catalog dump up front is exactly what
it is not.

#### Scenario: Sandbox standards forbid runtime installs

- **GIVEN** the shared sandbox-agent standards prompt
- **THEN** it directs the agent to look a package up with `list_available_packages` before importing one it is not certain is present, and states that no runtime installs are possible
