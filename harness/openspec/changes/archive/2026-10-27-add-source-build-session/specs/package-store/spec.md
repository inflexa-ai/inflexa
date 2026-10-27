# Spec Delta

## MODIFIED Requirements

### Requirement: One inflexa.lock is the farm metadata contract

A farm MUST carry exactly one metadata file, `inflexa.lock`, beside its link
trees and its caches. The file MUST be JSON at schema version 1, with these
fields:

- `schema` — the number 1.
- `arch` — `"amd64"` or `"arm64"`.
- `packages` — one entry per linked distribution: `name`, `version`,
  `track` (the subtree of its links), `store_dir`, `hash` (the full tree
  sha256), and `requested`. `requested` obeys the PEP 376 meaning: true for
  a direct ask, false for a transitive dependency. An entry of a
  source-built distribution MUST also carry `source`: the URL and the
  commit of a git source, or the tree hash of a local folder, together
  with the qualified pin of the store directory. An index entry carries no
  `source`, because the pinned index is its provenance.
- `languages` — the per-language provenance. `python` carries `version`
  and `index`. `r` carries `version`, `bioc_releases`, and the embedded
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
farm contract. The `source` field is additive, thus the schema number stays
1.

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
configured, or a K8s `fixed` farm source without the host mountpoint of
the libs volume.

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

#### Scenario: A source-built entry carries its source

- **GIVEN** a farm that links the source-built `SeedMatchR==2.0.0@git:2fc0c4f`
- **WHEN** the lock is read
- **THEN** its entry carries `source` with the URL, the commit `2fc0c4f`, and the qualified pin, and the lock still parses at schema 1

#### Scenario: An index entry carries no source

- **GIVEN** a farm that links the CRAN `Seurat`
- **WHEN** the lock is read
- **THEN** its entry carries no `source` field

### Requirement: The lib-store resolver env is injected only when the store is mounted

When the lib store is mounted, the mount plan MUST emit the package-resolver
env so language runtimes resolve imports against the mounted farm.
`R_LIBS_SITE` MUST cover the github/bioconductor/cran/source subtrees of
the farm, thus a source-built R package loads beside the catalog tracks.
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

#### Scenario: A source-built R package loads through the resolver env

- **GIVEN** a farm that links a source-built R package under `r/source`
- **WHEN** the mount plan is built
- **THEN** `R_LIBS_SITE` covers the `r/source` subtree of the farm

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

A package section MUST carry its `track` as data, `python` or `r`. One
mapping turns a lock subtree into a track: `python` gives `python`, and
`cran`, `bioconductor`, `github`, and `source` give `r`. A title is display
only, and no reader MUST derive a track from a title. A section of system
tools or of node packages carries no track.

Each answer MUST render the version beside the name, as `name==version`.
The targeted `names` path MUST also carry the store directory and the full
content hash when the source gives them. A full listing carries no hashes,
because a thousand rows of sha256 bury the signal. A missing or unreadable
source is an expected state: the tool MUST NOT throw — it MUST return an
`available: false` data variant carrying a fallback note rather than an
error. When the pool-scope source reports itself unavailable, the note
MUST carry the reason of the embedder. Without the reason, a structural
fault reads as a transient one, and the agent retries without end.

The `names` path MUST read each entry with `parseQuery` of the
`package-identity` capability. It MUST then resolve the query through
`resolveQuery`, over an index of the package sections. An entry that does
not parse MUST answer absent, because a census reports a state and it
never refuses a call. A resolved query answers one present entry, with the
exact spelling and the section of its identity. An ambiguous query answers
one present entry for each track. An unknown query answers absent, and it
carries the `suggestion` when the resolution gives one.

A name of a system tool or of a node package matches its rendered name
without case. The identity rule covers a distribution of an ecosystem, and
it does not cover a binary. A listing MUST mark each name that the Python
track and the R track both hold as one identity name. The mark MUST show
the two forms that a plan writes, `python:<name>` and `r:<name>`.

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

#### Scenario: A system tool matches without case

- **GIVEN** a `system_tools` entry whose executable is `bcftools`
- **WHEN** the tool checks `names: ["BCFtools"]`
- **THEN** the answer marks it present under `System tools (CLI)`

#### Scenario: A qualified entry reads one track

- **GIVEN** a pool whose R section holds `Seurat` and whose Python section holds `igraph`
- **WHEN** the tool checks `names: ["r:Seurat", "python:igraph"]`
- **THEN** the answer marks both present, each under the section of its own track

#### Scenario: An absent image record merges nothing

- **GIVEN** a readable farm lock and no `image-packages.json` at the store root
- **WHEN** the tool lists
- **THEN** it returns `{ available: true, ... }` with the farm tracks alone, without a throw

#### Scenario: An invalid image record merges nothing

- **GIVEN** an `image-packages.json` that does not parse at schema 1
- **WHEN** the tool lists
- **THEN** it returns the farm tracks alone, without a throw

#### Scenario: A section carries its track

- **GIVEN** a farm lock with rows in the `cran` and `bioconductor` subtrees
- **WHEN** the tool lists with `language: "r"`
- **THEN** both sections are listed, and the filter reads the track of the section and not its title

#### Scenario: A both-track name answers once for each track

- **GIVEN** a pool whose Python section holds `igraph==1.0.0` and whose R section holds `igraph==2.1.4`
- **WHEN** the tool checks `names: ["igraph"]`
- **THEN** the answer holds two present entries for `igraph`: one under the Python section, and one under the R section, each with its version

#### Scenario: A folded spelling resolves to its Python identity

- **GIVEN** a pool whose Python section holds `decoupler` and whose R section holds `decoupleR`
- **WHEN** the tool checks `names: ["decoupler"]`
- **THEN** the answer holds one present entry, `decoupler` under the Python section

#### Scenario: A separator fold reaches the package

- **GIVEN** a pool whose Python section holds `scikit-learn`
- **WHEN** the tool checks `names: ["scikit_learn"]`
- **THEN** the answer marks it present as `scikit-learn` under the Python section

#### Scenario: A folded R spelling answers absent with the suggestion

- **GIVEN** a pool whose R section holds `Seurat` and whose Python section holds no `seurat`
- **WHEN** the tool checks `names: ["seurat"]`
- **THEN** the answer marks it absent, with the suggestion `Seurat`

#### Scenario: The listing marks a both-track name

- **GIVEN** a pool whose Python section and R section both hold `igraph`
- **WHEN** the tool lists
- **THEN** each `igraph` row carries a mark that names `python:igraph` and `r:igraph`, and no other row carries a mark

#### Scenario: A source-built package lists under the R track

- **GIVEN** a farm lock with a `source`-subtree entry `SeedMatchR==2.0.0`
- **WHEN** the tool lists with `language: "r"`
- **THEN** the section lists, because the mapping reads the `source` subtree as the `r` track
