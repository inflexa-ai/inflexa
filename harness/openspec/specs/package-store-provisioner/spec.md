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
`<name>-<version>-<hash16>`. A store directory MUST never change after its
publish. An R package MUST nest as `<dir>/<Name>/`, because R rebuilds its
own path as libname plus name. The content address MUST be a sha256 over
the sorted tree: each relative path, the file bytes, the executable bit,
and each symlink target. The provisioner markers and the derived warm
artifacts (`__pycache__`, `.pyc`, `.nbi`, `.nbc`) MUST stay out of the
hash, because warm-up writes them after the address is taken. The directory
name carries the first 16 hex characters. The store MUST carry no `current`
pointer and no lease files.

#### Scenario: One copy serves many farms

- **GIVEN** two farms that link one package version
- **WHEN** the pool is inspected
- **THEN** one store directory holds the one copy

#### Scenario: No pointer at the store root

- **WHEN** the store root is listed after any run
- **THEN** no `current` entry and no `leases/` directory exists

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
temp-file-plus-rename write. A node is one store directory. A node carries
the track, the name, the version, the imports, the entry points, the edges,
and `r_dir` for R. A `by_name` ordering lists the directories of each name,
newest first. Python edges come from the distribution metadata, with markers
evaluated through `packaging` and `extra=""`. An unparseable marker keeps
the edge. R edges come from `Depends` and `Imports` only. `LinkingTo`
records as build metadata and gives no edge. An edge that names no node MUST
stop the run, unless the image-owned list holds the name.

#### Scenario: A dangling edge stops the build

- **GIVEN** an installed package whose dependency resolves to no store directory and no image-owned name
- **WHEN** the graph publishes
- **THEN** the run fails and names the edge

#### Scenario: LinkingTo gives no edge

- **GIVEN** an R package with a `LinkingTo` entry
- **WHEN** its node is emitted
- **THEN** the entry is absent from the edges and present in the build metadata

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

An acquire request MUST carry an explicit ecosystem, or none. With none, the
run MUST search both ecosystems. When both hold the name, the run MUST stop
with a both-hit outcome that names the two candidates, and the host asks the
user. A silent Python-first win is a fault.

#### Scenario: A both-hit name asks instead of guessing

- **GIVEN** a request for a name that PyPI and CRAN both hold, with no ecosystem given
- **WHEN** the acquire run resolves it
- **THEN** the outcome is a both-hit refusal with the two candidates, and nothing installs

### Requirement: Reclamation is exclusive and lease-free

`reclaim` MUST run under an exclusive lock, and it MUST remove only the
store directories that no farm references. `remove-farm` MUST remove the
named farm and its links, and it MUST NOT touch the pool. No lease guards a
removal: the host gates its own delete flow on live work.

#### Scenario: A referenced directory survives reclamation

- **GIVEN** a store directory that one farm links
- **WHEN** `reclaim` runs
- **THEN** the directory stays
