# package-store Specification

## Purpose

The sandbox base image carries the R, Python, and Node.js runtimes but **no
analysis packages**. The packages live in a host **package store**: a
content-addressed pool of package trees, plus one **farm** per analysis that
links the packages of that analysis. Every sandbox receives two read-only
mounts: the store root at `/mnt/libs`, and the farm of its analysis at the
farm container path. A sandbox step is physically unable to install anything
at runtime, because there is no network and the mounts are read-only.

Agents never assume packages or paths. They discover what is available
through the `list_available_packages` tool, which reads the inventory
source that the embedder binds: the `inflexa.lock` of the mounted farm for
a sandbox agent, and a pool-scope source for a conversation or planning
surface. When the store is mounted, the harness also injects the
language-resolver env, so imports resolve against the farm without
per-script path wiring.

The store is supplied by the embedder: the Docker backend bind-mounts a host
directory (`libStorePath`), the Kubernetes backend mounts a read-only PVC
(`libStorePvc`). How that directory or PVC is *built and published* is owned
by the package-store build pipeline (`package-store-build`). This spec
describes only the runtime mount contract and the discovery surface.

## Requirements

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

One schema definition MUST validate the shape at each read, and the mount
gate and the inventory MUST read this one file. The zod shape of the
harness is that definition — a second copy in another format can drift,
and nothing would read it. The mount gate MUST accept a farm
only when `inflexa.lock` parses and its schema version is known. The legacy
markers `packages.txt`, `meta.json`, and `lock.json` MUST NOT be part of the
farm contract.

The gate belongs to the party that can read the farm. A backend with a
host-readable farm path MUST prove the lock itself, before the mount. A
backend whose farm rides a volume the host cannot read MUST get the proof
from the farm resolver. There the resolver MUST answer `unavailable` when
the lock does not parse, and the backend mounts only a resolved farm. A K8s
configuration CAN name the host mountpoint of the libs volume, and the
backend then proves the lock itself, through the joined path. The sandbox
client factory MUST forward that root to the backend, because an embedder
composes through the factory and never builds the backend config itself.
Under a fixed farm source no resolver exists, thus the forwarded root
carries the only gate that shape can have.

An embedder CAN declare the fact `packageStore: "required"` on the sandbox
client config. Under the fact, a gate failure MUST refuse the create with
the `farm_unusable` error, which carries the farm path, the lock path, the
lock error type, and the cause, and no container and no Job is made.
Without the fact, a gate failure degrades. The sandbox client factory MUST
refuse at composition when the fact is set and no gate can run: no store
configured, or a K8s `fixed` farm source without the host mountpoint of the
libs volume.

#### Scenario: The gate reads the lock

- **GIVEN** a farm directory with a valid `inflexa.lock`
- **WHEN** the mount gate runs
- **THEN** the farm mounts, with no read of `packages.txt` or `meta.json`

#### Scenario: A farm without the lock is unusable

- **GIVEN** a farm directory with no `inflexa.lock`
- **WHEN** the mount gate runs
- **THEN** the sandbox degrades to `available: false` with a logged warning, and no store mount is made

#### Scenario: A volume-backed farm is proved by its resolver

- **GIVEN** a backend whose farm path is relative to a volume the host cannot read
- **WHEN** the resolver cannot parse the `inflexa.lock` of the farm
- **THEN** the resolution answers `unavailable` with the reason, and no container is made

#### Scenario: A host-readable volume root restores the backend gate

- **GIVEN** a K8s backend whose config names the host mountpoint of the libs volume
- **WHEN** the `inflexa.lock` of the resolved farm does not parse
- **THEN** the sandbox degrades to `available: false` with a logged warning, and no store mount is made

#### Scenario: A required store refuses an unusable farm on Docker

- **GIVEN** a Docker backend with `packageStore: "required"` and a resolved farm whose `inflexa.lock` does not parse
- **WHEN** `createSandbox` runs
- **THEN** the call refuses with `farm_unusable`, the error names the lock path and the lock error type, and no container is made

#### Scenario: A required store refuses an unusable farm on K8s

- **GIVEN** a K8s backend with `packageStore: "required"`, the host mountpoint of the libs volume, and a resolved farm whose `inflexa.lock` is absent
- **WHEN** `createSandbox` runs
- **THEN** the call refuses with `farm_unusable`, the lock path is the joined path under the mountpoint, and no Job is made

#### Scenario: A required store without a gate refuses at composition

- **GIVEN** a config with `packageStore: "required"` and no `libStorePath` on Docker, or a `fixed` farm source and no `libStorePvcRoot` on K8s
- **WHEN** `createSandboxClient` runs
- **THEN** it throws, and the message names the missing field

### Requirement: The per-analysis cache mounts read-write

A farm resolution MUST be able to carry an optional cache location. When it
is present, both backends MUST mount it read-write at `/mnt/libs/cache`,
after the two store binds. With `toolchainSource: "image"` and a present
cache mount, `NUMBA_CACHE_DIR` and `MPLCONFIGDIR` MUST point into
`/mnt/libs/cache`. A missing cache location MUST degrade: no cache mount,
and the entrypoint fallback serves. A cache location that the backend
cannot mount safely MUST degrade the same way, with a logged warning. The
cache is per analysis, because a loaded numba entry executes machine code.

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
sandbox client MUST carry the value it was composed with as
`toolchainSource`, normalized to `"store"` when the config has none, thus the
one declaration reaches each consumer. The harness MUST key the resolver
environment and the agent-facing environment text on this declared value
only. The agent composition MUST read the value from the sandbox client, and
the agent deps MUST NOT carry a second declaration, because a bag that
disagrees with the client describes an environment the sandbox does not
have. The harness MUST NOT infer its host or its image generation.

#### Scenario: The client normalizes the absent field

- **GIVEN** a config with no `toolchainSource`
- **WHEN** the sandbox client is composed
- **THEN** `client.toolchainSource` is `"store"`

#### Scenario: The agent composition reads the toolchain from the client

- **GIVEN** a sandbox client composed with `toolchainSource: "image"` and an agent deps bag with no toolchain field
- **WHEN** a sandbox agent is composed
- **THEN** its orient core states that an acquisition is a host action

#### Scenario: The absent field keeps the legacy environment

- **GIVEN** a config with no `toolchainSource`
- **WHEN** the mount plan is built with the store mounted
- **THEN** the emitted env equals the legacy env, with the conda `bin` under `/mnt/libs/current`

#### Scenario: The declared image toolchain moves the env

- **GIVEN** `toolchainSource: "image"`
- **WHEN** the mount plan is built with the store mounted
- **THEN** `PATH` holds `/opt/conda/bin` before the farm `python/bin` at the end, and `NODE_PATH` is `/opt/node/node_modules`

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
`defineTool`. The tool MUST read the inventory source that the embedder
binds. A sandbox agent reads the `inflexa.lock` of the mounted farm,
because a step imports only what the farm links. A conversation or
planning surface reads a pool-scope source, because the ask flow marks the
packages that the POOL does not hold.

The tool MUST merge the image record into either report. The record is
`image-packages.json` at the store root. The default path MUST be the
container mountpoint, `/mnt/libs/image-packages.json`, and
`imagePackagesFile` names another location. The harness MUST export the
file name as `IMAGE_PACKAGES_FILE`, thus an embedder joins it onto its own
store root and never spells the name. The zod schema of the harness
MUST validate the record at each read, and that schema is the one
definition of the shape. An absent or invalid record MUST merge nothing,
and the report MUST stay whole. A `system_tools` entry MUST render under
the title `System tools (CLI)`, by its `executable` name, and a `node`
entry under the title `Node (npm)`.

Each answer MUST render the version beside the name, as `name==version`.
The targeted `names` path MUST also carry the store directory and the full
content hash when the source gives them. A full listing carries no hashes,
because a thousand rows of sha256 bury the signal. A missing or unreadable
source is an expected state: the tool MUST NOT throw — it MUST return an
`available: false` data variant carrying a fallback note rather than an
error. When the pool-scope source reports itself unavailable, the note
MUST carry the reason of the embedder. Without the reason, a structural
fault reads as a transient one, and the agent retries without end.

The `names` path matches a name without case, and it echoes the exact
spelling of the source, because an R name is case-sensitive at `library()`.
It MUST answer with one entry for each section that holds the name, in the
section order. A name that two tracks hold has two exact spellings and two
store identities, and a first-writer answer hides one of them. A listing
MUST mark each name that the Python section and the R section both hold.
The mark MUST show the two forms that a plan writes, `python:<name>` and
`r:<name>`. A name that the two sections hold in two spellings, such as
`decoupler` and `decoupleR`, needs no mark, because the spelling settles
it.

#### Scenario: Packages available

- **WHEN** `list_available_packages` is called and the `inflexa.lock` of the mounted farm is readable
- **THEN** it returns `{ available: true, ... }` with the farm inventory as `name==version` rows, merged with the image record

#### Scenario: Store not mounted

- **WHEN** `list_available_packages` is called and the lock cannot be read
- **THEN** it returns `{ available: false, content }`, and the content names the missing mount, without a throw

#### Scenario: A pool-scope answer carries the pinned version

- **WHEN** a conversation surface asks `names: ["scipy"]` against a pool that pins `scipy==1.16.3`
- **THEN** the answer marks it present as `scipy==1.16.3`, with the store directory and the full hash

#### Scenario: An unreadable pool names its reason

- **WHEN** the pool-scope source answers unavailable with a reason
- **THEN** the tool returns `available: false`, and the content carries that reason beside the UNKNOWN note

#### Scenario: The image record renders versions

- **GIVEN** a readable `image-packages.json` with `samtools` at `1.22.1` and `echarts` at `6.0.0`
- **WHEN** the tool lists with `language: "cli"`
- **THEN** the report holds `samtools==1.22.1` under `System tools (CLI)`, and no Node row

#### Scenario: A tool renders by its executable name

- **GIVEN** a `system_tools` entry with `name` `eagle2` and `executable` `eagle`
- **WHEN** the tool checks `names: ["eagle"]`
- **THEN** the answer marks it present under `System tools (CLI)`

#### Scenario: An absent image record merges nothing

- **GIVEN** a readable farm lock and no `image-packages.json` at the store root
- **WHEN** the tool lists
- **THEN** it returns `{ available: true, ... }` with the farm tracks alone, without a throw

#### Scenario: An invalid image record merges nothing

- **GIVEN** an `image-packages.json` that does not parse at schema 1
- **WHEN** the tool lists
- **THEN** it returns the farm tracks alone, without a throw

#### Scenario: A both-track name answers once for each track

- **GIVEN** a pool whose Python section holds `igraph==1.0.0` and whose R section holds `igraph==2.1.4`
- **WHEN** the tool checks `names: ["igraph"]`
- **THEN** the answer holds two present entries for `igraph`: one under the Python section, and one under the R section, each with its version

#### Scenario: A two-spelling pair answers with both spellings

- **GIVEN** a pool whose Python section holds `decoupler` and whose R section holds `decoupleR`
- **WHEN** the tool checks `names: ["decoupler"]`
- **THEN** the answer holds two present entries, `decoupler` under the Python section and `decoupleR` under the R section

#### Scenario: The listing marks a both-track name

- **GIVEN** a pool whose Python section and R section both hold `igraph`
- **WHEN** the tool lists
- **THEN** each `igraph` row carries a mark that names `python:igraph` and `r:igraph`, and no other row carries a mark

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

When the composition binds the `ExtendAnalysisFarm` seam, the instructions
MUST route an absent package through `link_packages` first. The agent then
reports the package as missing only after the link tool answers `absent` or
`unavailable`. The reason: the pool is staged on the same mount, thus a farm
lookup alone does not bound what an import can reach.

#### Scenario: Sandbox standards forbid runtime installs

- **GIVEN** the shared sandbox-agent standards prompt
- **THEN** it directs the agent to call `list_available_packages` before an uncertain import
- **AND** it states that an acquisition is a host action
- **AND** it directs the agent to report a missing package

#### Scenario: A bound link seam routes an absent package through the link tool

- **GIVEN** a composition with the `ExtendAnalysisFarm` seam bound
- **WHEN** the composed system prompt is inspected
- **THEN** it directs the agent to call `link_packages` before it reports a package missing
