# Delta: lib-store

The capability renames to **package-store** at sync time, per decision 14 of
`docs/feat_localPackages/decisions.md`. The delta stays under the current
folder name, so the tooling matches the existing spec.

## ADDED Requirements

### Requirement: The embedder names the farm source

`farmSource` MUST be a required field of each sandbox backend config. The
union MUST have exactly two kinds. `fixed` names one farm location for every
analysis. `per-analysis` supplies a resolver: the analysis id in, and a farm
location or an `unavailable` state with a reason out. The harness MUST NOT
invent a farm location, and it MUST NOT read a store-root `current` pointer.
A backend MUST resolve the farm source at each `createSandbox` call. Thus a
farm made between two sandboxes reaches the next sandbox with no restart.

#### Scenario: A missing farm source fails at compile time

- **WHEN** an embedder composition root passes no `farmSource`
- **THEN** the build of the embedder fails to compile

#### Scenario: An unavailable resolution refuses the sandbox

- **GIVEN** a `per-analysis` farm source whose resolver returns `unavailable` with a reason
- **WHEN** `createSandbox` runs for that analysis
- **THEN** the call refuses with a `farm_unavailable` error that carries the reason of the embedder

#### Scenario: A fixed source serves every analysis

- **GIVEN** a `fixed` farm source
- **WHEN** sandboxes of two different analyses are created
- **THEN** both mount the one named farm

### Requirement: One inflexa.lock is the farm metadata contract

A farm MUST carry exactly one metadata file, `inflexa.lock`, beside its link
trees and its caches. The file MUST be JSON at schema version 1, with these
fields:

- `schema` — the number 1.
- `arch` — `"amd64"` or `"arm64"`.
- `packages` — one entry per linked distribution: `name`, `version`,
  `track` (the subtree of its links), `store_dir`, `hash` (the full tree
  sha256), and `requested`. `requested` obeys the PEP 376 meaning: true for
  a direct ask, false for a transitive dependency.
- `languages` — the per-language provenance. `python` carries `version` and
  `index`. `r` carries `version`, `bioc_releases`, and the embedded
  `pak_lock`. Each language object owns its own fields, and the JSON schema
  validates each shape.
- `warm` — the replay record, in the catalog farm only: per package, the
  `script_sha256` of its warm script and its `cache_entries`.
- `merge_conflicts` — the top-level entries that the link merge kept-first
  or skipped.

A dedicated JSON schema file MUST validate the shape, and the mount gate and
the inventory MUST read this one file. The mount gate MUST accept a farm
only when `inflexa.lock` parses and its schema version is known. The legacy
markers `packages.txt`, `meta.json`, and `lock.json` MUST NOT be part of the
farm contract.

#### Scenario: The gate reads the lock

- **GIVEN** a farm directory with a valid `inflexa.lock`
- **WHEN** the mount gate runs
- **THEN** the farm mounts, with no read of `packages.txt` or `meta.json`

#### Scenario: A farm without the lock is unusable

- **GIVEN** a farm directory with no `inflexa.lock`
- **WHEN** the mount gate runs
- **THEN** the sandbox degrades to `available: false` with a logged warning, and no store mount is made

### Requirement: The per-analysis cache mounts read-write

A farm resolution MUST be able to carry an optional cache location. When it
is present, both backends MUST mount it read-write at `/mnt/libs/cache`,
after the two store binds. With `toolchainSource: "image"` and a present
cache mount, `NUMBA_CACHE_DIR` and `MPLCONFIGDIR` MUST point into
`/mnt/libs/cache`. A missing cache location MUST degrade: no cache mount,
and the entrypoint fallback serves. The cache is per analysis, because a
loaded numba entry executes machine code.

#### Scenario: The cache mount rides the farm resolution

- **GIVEN** a farm resolution that carries a cache location
- **WHEN** a sandbox is created
- **THEN** the container has a read-write bind at `/mnt/libs/cache`, and the two cache env vars point into it

#### Scenario: No cache location degrades

- **GIVEN** a farm resolution with no cache location
- **WHEN** a sandbox is created
- **THEN** no cache mount exists, the sandbox serves, and the entrypoint fallback covers the caches

### Requirement: The toolchain source is a declared fact

The backend config MUST carry a `toolchainSource` field with the values
`"image"` and `"store"`, and the absent field MUST mean `"store"`. The
harness MUST key the resolver environment and the agent-facing environment
text on this declared value only. The harness MUST NOT infer its host or its
image generation.

#### Scenario: The absent field keeps the legacy environment

- **GIVEN** a config with no `toolchainSource`
- **WHEN** the mount plan is built with the store mounted
- **THEN** the emitted env equals the legacy env, with the conda `bin` under `/mnt/libs/current`

#### Scenario: The declared image toolchain moves the env

- **GIVEN** `toolchainSource: "image"`
- **WHEN** the mount plan is built with the store mounted
- **THEN** `PATH` holds `/opt/conda/bin` before the farm `python/bin` at the end, and `NODE_PATH` is `/opt/node/node_modules`

## MODIFIED Requirements

### Requirement: The library store is a read-only mount at /mnt/libs

When a library store is configured, the sandbox container MUST receive two
nested read-only mounts: the store root at `/mnt/libs`, and the farm of
the analysis at the farm container path. With `toolchainSource: "image"`
the farm path is `/mnt/libs/farm`. With `"store"` it stays
`/mnt/libs/current`, because the baked resolvers of the old images name
it. The farm MUST come from the resolved farm
source. The farm bind MUST come after the store bind, thus the nesting is
stable. The Docker backend MUST bind-mount the host directory named by
`libStorePath` and the resolved farm path. The Kubernetes backend MUST mount
the PVC named by `libStorePvc`, with the farm as a `subPath` mount at the
same farm container path. When no store is configured, the container MUST receive
no `/mnt/libs` mount and no lib-store env, and the farm source MUST NOT run.

#### Scenario: Docker mounts the store and the farm read-only

- **GIVEN** `libStorePath` is set and the farm source resolves a farm
- **WHEN** a Docker sandbox is created
- **THEN** the container has a read-only bind of the store at `/mnt/libs` and a read-only bind of the farm at the farm container path

#### Scenario: Kubernetes mounts the farm as a subPath

- **GIVEN** `libStorePvc` is set and the farm source resolves a farm
- **WHEN** a sandbox pod spec is built
- **THEN** the pod mounts the PVC read-only at `/mnt/libs` and the farm subPath read-only at the same farm container path

#### Scenario: No lib store configured

- **GIVEN** neither `libStorePath` nor `libStorePvc` is set
- **WHEN** a sandbox is created
- **THEN** the container has no `/mnt/libs` mount, no lib-store env vars, and the farm source is not called

### Requirement: Packages are discoverable via the list_available_packages tool

The harness MUST expose a `list_available_packages` tool, built with
`defineTool`. The tool reads the `inflexa.lock` of the mounted farm, at the farm
container path. When the baked image fragment at
`/opt/inflexa/image-packages.txt` exists, the tool merges it into the
report. A missing or unmounted store is an expected state: the tool MUST NOT
throw — it MUST return an `available: false` data variant carrying a
fallback note rather than an error.

#### Scenario: Packages available

- **WHEN** `list_available_packages` is called and the `inflexa.lock` of the mounted farm is readable
- **THEN** it returns `{ available: true, ... }` with the package inventory of the farm merged with the image fragment

#### Scenario: Store not mounted

- **WHEN** `list_available_packages` is called and the lock cannot be read
- **THEN** it returns `{ available: false, content }`, and the content names the missing mount, without a throw

### Requirement: The lib-store resolver env is injected only when the store is mounted

When the lib store is mounted, the mount plan MUST emit the package-resolver
env so language runtimes resolve imports against the mounted farm.
`R_LIBS_SITE` MUST cover the github/bioconductor/cran subtrees of the farm.
With `toolchainSource: "store"` (or absent), `NODE_PATH` MUST be
`/mnt/libs/current/node/node_modules`, and `PATH` MUST include
`/mnt/libs/current/conda/bin`. With `toolchainSource: "image"`, `NODE_PATH`
MUST be `/opt/node/node_modules`. `PATH` MUST then include `/opt/conda/bin`,
with the farm `python/bin` appended at the end. Thus a farm script never
shadows an image tool. `PYTHONPATH` MUST NOT be set — system Python resolves
the store through a `.pth` file. When the store is not mounted, none of
these vars MUST be emitted.

#### Scenario: Resolver env present with the store mounted

- **GIVEN** the lib store is mounted and no `toolchainSource` is declared
- **WHEN** the mount plan is built
- **THEN** `R_LIBS_SITE`, `NODE_PATH`, and a conda-`bin` `PATH` are emitted and `PYTHONPATH` is absent

#### Scenario: The farm bin never shadows an image tool

- **GIVEN** the lib store is mounted and `toolchainSource: "image"` is declared
- **WHEN** the mount plan is built
- **THEN** the `PATH` ends with the farm `python/bin`, after every image path

### Requirement: No runtime package installation

The base image MUST NOT bake in analysis packages, and sandbox steps MUST
NOT install packages at runtime — only what the farm links is importable. An
acquisition MUST be a host action. Sandbox agent instructions MUST direct
agents to call `list_available_packages` before an import of a package that
is not certainly staged. The instructions MUST state that an acquisition is
a host action. They MUST direct the agent to report a missing package, not
to retry an install. The lookup is targeted and conditional — a catalog dump
up front is exactly what it is not.

#### Scenario: Sandbox standards forbid runtime installs

- **GIVEN** the shared sandbox-agent standards prompt
- **THEN** it directs the agent to call `list_available_packages` before an uncertain import
- **AND** it states that an acquisition is a host action
- **AND** it directs the agent to report a missing package
