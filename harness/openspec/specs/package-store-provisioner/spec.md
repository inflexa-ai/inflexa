# package-store-provisioner Specification

## Purpose

The contract of the `sandbox-provisioner` entrypoint: the one program that
writes the package store. The build workflow and the host commands call it
in named modes. The pool layout, the farm publish, and the dependency
graph are its outputs, and the `package-store` runtime contract consumes
them.

## Requirements


### Requirement: The entrypoint has subcommands with named callers

The provisioner entrypoint MUST expose exactly five subcommands, one mode
each: `build`, `acquire`, `prepare`, `reclaim`, and `remove-farm`. An
impossible combination MUST be impossible by structure, not by a runtime
refusal. Each subcommand has exactly one caller:

- `build` — the store build workflow. It resolves the manifest and builds
  the catalog farm.
- `acquire` — the acquisition flights of the host. It installs a spec set
  into the pool, and it stages the graph nodes for the host commit.
- `prepare` — the store build workflow. It runs the warm scripts against
  the catalog.
- `reclaim` — the host reclamation command. It removes unreferenced store
  directories under an exclusive lock.
- `remove-farm` — the analysis delete flow of the host. It removes one
  farm and never touches the pool.

No `verify` mode exists, because CI validates inside the sandbox image and
no other caller exists. No lease mode exists. Repair of abandoned staging
debris MUST run as an internal step at the start of each run, not as a
subcommand.

#### Scenario: A combined mode is unrepresentable

- **WHEN** a caller passes two subcommands in one invocation
- **THEN** the entrypoint refuses at argument parse time

#### Scenario: Repair is automatic

- **GIVEN** staging debris from a crashed prior run
- **WHEN** any subcommand starts
- **THEN** the debris is removed before the mode runs

### Requirement: The pool is content-addressed and write-once

Each installed distribution MUST store once, in a directory named
`<address>-<version>-<hash16>`. The address is the address of the
identity of the package: the PEP 503 fold of the identity name, for both
tracks. A store directory MUST never change after its publish. An R
package MUST nest as `<dir>/<name>/`, where `<name>` is the identity
name, because R rebuilds its own path as libname plus name. The content
address MUST be a sha256 over the sorted tree: each relative path, the
file bytes, the executable bit, and each symlink target. The provisioner
markers and the derived warm artifacts (`__pycache__`, `.pyc`, `.nbi`,
`.nbc`) MUST stay out of the hash, because warm-up writes them after the
address is taken. The directory name carries the first 16 hex characters.
The store MUST carry no `current` pointer and no lease files.

#### Scenario: One copy serves many farms

- **GIVEN** two farms that link one package version
- **WHEN** the pool is inspected
- **THEN** one store directory holds the one copy

#### Scenario: No pointer at the store root

- **WHEN** the store root is listed after any run
- **THEN** no `current` entry and no `leases/` directory exists

#### Scenario: The address folds the R identity

- **GIVEN** the R package `GO.db` at version `3.21.0`
- **WHEN** the provisioner stores it
- **THEN** the directory is `go-db-3.21.0-<hash16>`, and the inner directory is `GO.db`

### Requirement: A farm publishes atomically with relative hoisted links

A farm build MUST publish by a crash-atomic staging swap, and
`inflexa.lock` MUST write last inside the staging. Thus a crash leaves no
half farm that the mount gate accepts. A hoisted console script MUST link
relatively, because an absolute link dangles under a swap.

#### Scenario: A crash leaves no accepted farm

- **GIVEN** a farm build that dies before the lock write
- **WHEN** the mount gate reads the staging remains
- **THEN** no `inflexa.lock` exists there, and the gate refuses the directory

#### Scenario: A hoisted script survives the swap

- **GIVEN** a farm with a hoisted console script
- **WHEN** the staging swap publishes the farm
- **THEN** the script link resolves, because its target is relative

### Requirement: The graph is exact and gated

The provisioner MUST publish `deps.json` at the store root with a
temp-file-plus-rename write. The graph version is 2. A node is one store
directory. A node carries the track, the name, the version, the imports,
the entry points, and the edges. The name of a node MUST be the identity
name: `python_identity` of the METADATA `Name` for a Python distribution,
and `r_identity` of the DESCRIPTION `Package` for an R package. No other
field carries a name. A `by_name` ordering lists the directories of each
identity name, newest first, under the track of the identity. Thus the R
track keys `decoupleR`, the Python track keys `decoupler`, and the two
tracks never share a key by the fold alone. The store directory name
keeps the address, because the directory is an address and not an
identity.

Python edges come from the distribution metadata, with markers evaluated
through `packaging` and `extra=""`. An unparseable marker keeps the edge.
R edges come from `Depends` and `Imports` only. `LinkingTo` records as
build metadata and gives no edge. An edge MUST name a store directory. An
edge that names no node MUST stop the run, unless the image-owned list
holds the name.

The gate MUST report each name that the Python track and the R track hold
in one spelling. A plan must qualify such a name, thus the planner must
see the list. The report is a log line, and the run continues.

#### Scenario: A dangling edge stops the build

- **GIVEN** an installed package whose dependency resolves to no store directory and no image-owned name
- **WHEN** the graph publishes
- **THEN** the run fails and names the edge

#### Scenario: LinkingTo gives no edge

- **GIVEN** an R package with a `LinkingTo` entry
- **WHEN** its node is emitted
- **THEN** the entry is absent from the edges and present in the build metadata

#### Scenario: An R node keeps its DESCRIPTION spelling

- **GIVEN** a store directory `decoupler-2.17.0-<hash>` whose inner directory is `decoupleR`
- **WHEN** its node is emitted
- **THEN** the node name is `decoupleR`, `by_name.r` holds the key `decoupleR`, and the node carries no `r_dir`

#### Scenario: A Python node keeps the PEP 503 form

- **GIVEN** a Python distribution whose metadata name is `Decoupler`
- **WHEN** its node is emitted
- **THEN** the node name is `decoupler`, and `by_name.python` holds the key `decoupler`

#### Scenario: The version stripped from a directory name uses the address

- **GIVEN** an R store directory `go-db-3.21.0-<hash>` whose inner directory is `GO.db`
- **WHEN** its node is emitted
- **THEN** the node version is `3.21.0`, and the node name is `GO.db`

#### Scenario: A same-spelling both-track name is reported

- **GIVEN** a Python node `igraph` and an R node `igraph`
- **WHEN** the gate runs
- **THEN** the build log names `igraph` as a both-track name, and the run continues

#### Scenario: The graph carries version 2

- **WHEN** the graph publishes
- **THEN** `version` reads 2, and no node carries `r_dir`

### Requirement: An acquisition is batched and two-phase

`acquire` MUST accept a set of specs in one run. Installs MUST run with
hashes enforced against the pinned index. The run MUST publish no advertised
state before the load check of the acquired set passes inside the sandbox
image. `acquire` MUST write the staged graph nodes as one data file, and it
MUST NOT touch `deps.json`. After the green check, the host appends the
staged nodes to `deps.json` under its metadata lock. The run MUST report one
outcome per spec. A spec that cannot
resolve MUST drop out with its own refusal, and the rest of the set MUST
still land. Parallel acquisitions MUST be permitted under a shared lock,
with per-run staging directories.

#### Scenario: One bad spec does not block the batch

- **GIVEN** an acquire run with three specs, one of which cannot resolve
- **WHEN** the run completes
- **THEN** two packages commit, and the third reports its own refusal

#### Scenario: A failed load check leaves no advertised state

- **GIVEN** an acquired package that fails its load check in the sandbox image
- **WHEN** the flight completes
- **THEN** `deps.json` holds no node for it, no farm links it, and a reclamation can free its bytes

### Requirement: R acquisition is incremental through pak

An R acquire MUST resolve the requested set with pak, against CRAN and
Bioconductor only. The `github` and `git` tracks are catalog-only, and an
acquisition of them MUST refuse. A resolved dependency that the pool already
holds at the resolved version MUST NOT install again. The run MUST record
the pak lock of the acquisition in the staged metadata, as provenance.

#### Scenario: A pool hit is not reinstalled

- **GIVEN** an R request whose dependency the pool holds at the resolved version
- **WHEN** the acquire run executes
- **THEN** the dependency links from the pool, and no second copy is built

#### Scenario: A git-track request refuses

- **WHEN** an acquire run receives a request for a git-pinned R package
- **THEN** the run refuses with the catalog-only reason

### Requirement: An unqualified name that both ecosystems satisfy stops

An acquire spec MUST be a query in the one grammar, read by `parse_query`
of the twin module. A query MUST carry an explicit track, or none. With
none, the run MUST search both ecosystems, each in the spelling of the
query. The R presence probe matches a name exactly, thus an R hit means
that the spelling is the R identity. When both hold the name, the run MUST
stop with a both-hit outcome that names the two identities, and the host
asks the user. A silent Python-first win is a fault.

#### Scenario: A both-hit name asks instead of guessing

- **GIVEN** a request for a name that PyPI and CRAN both hold, with no track given
- **WHEN** the acquire run resolves it
- **THEN** the outcome is a both-hit refusal with the two identities, and nothing installs

#### Scenario: The candidates are identities

- **GIVEN** an unqualified request `igraph` that PyPI and CRAN both hold
- **WHEN** the acquire run reports the both-hit
- **THEN** the candidates are `python:igraph` and `r:igraph`

#### Scenario: A spec parses through the twin

- **WHEN** the acquire run receives the spec `r:GO.db==3.21.0`
- **THEN** the query has the spelling `GO.db`, the track `r`, and the version `3.21.0`

### Requirement: Reclamation is exclusive and lease-free

`reclaim` MUST run under an exclusive lock. The reference set MUST be the
farm links plus the graph nodes, the same set for the plain pass and the
debris pass. A locally acquired package holds no farm link until a run
links it, thus a farm-only set would delete fresh inventory. And a
removal that ignores the graph leaves a dangling edge, and the strict
graph reader then refuses the whole pool.

`reclaim` MUST remove only an unreferenced directory. It MUST then prune
the `deps.json` node of every store directory that is gone, and thin
`by_name` to match. Thus the graph never advertises a package that no
link can land.

`remove-farm` MUST remove the named farm and its links, and it MUST NOT
touch the pool. No lease guards a removal: the host gates its own delete
flow on live work.

`reclaim --debris` MUST also remove the stale acquire reports under
`.inflexa-download/`, and it MUST NOT change the graph. The host owns the
triggers of the debris pass, and it gates them on live work.

#### Scenario: An advertised directory survives reclamation

- **GIVEN** a committed store directory that no farm links
- **WHEN** `reclaim` runs
- **THEN** the directory stays, because the graph advertises it

#### Scenario: A gone directory loses its node

- **GIVEN** a store directory that was removed outside the product
- **WHEN** `reclaim` runs
- **THEN** its graph node is pruned, and no `by_name` entry names it

#### Scenario: A referenced directory survives reclamation

- **GIVEN** a store directory that one farm links
- **WHEN** `reclaim` runs
- **THEN** the directory stays

#### Scenario: The debris pass removes only the unadvertised tier

- **GIVEN** one directory with a graph node and no farm link, and one directory with neither
- **WHEN** `reclaim --debris` runs
- **THEN** only the directory with neither leaves, and the graph is unchanged

#### Scenario: The debris pass removes a stale acquire report

- **GIVEN** an acquire report file that an ended flush left behind
- **WHEN** `reclaim --debris` runs
- **THEN** the report file is gone
