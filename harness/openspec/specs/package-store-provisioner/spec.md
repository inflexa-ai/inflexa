# package-store-provisioner Specification

## Purpose

The contract of the `sandbox-provisioner` entrypoint: the one program that
writes the package store. The build workflow and the host commands call it
in named modes. The pool layout, the farm publish, and the dependency
graph are its outputs, and the `package-store` runtime contract consumes
them.

## Requirements


### Requirement: The entrypoint has subcommands with named callers

The provisioner entrypoint MUST expose exactly six subcommands, one mode
each: `build`, `acquire`, `acquire-source`, `prepare`, `reclaim`, and
`remove-farm`. An impossible combination MUST be impossible by structure, not by a runtime
refusal. Each subcommand has exactly one caller:

- `build` — the store build workflow. It resolves the manifest and builds
  the catalog farm.
- `acquire` — the acquisition flights of the host. It installs a spec set
  into the pool, and it stages the graph nodes for the host commit.
- `acquire-source` — the source-build flight of the host. It runs the
  approved build script over a pristine source snapshot in a fresh
  container run, writes the artifact into the pool, stages the graph
  nodes for the host commit, and writes the build record.
- `prepare` — the store build workflow. It runs the warm scripts against
  the catalog.
- `reclaim` — the host reclamation command. It removes unreferenced store
  directories under an exclusive lock.
- `remove-farm` — the analysis delete flow of the host. It removes one
  farm and never touches the pool.

No `verify` mode exists, because CI validates inside the sandbox image and
no other caller exists. No lease mode exists. A build session is not a
subcommand: the host starts a held container of the image and sends each
command itself. Repair of abandoned staging
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
hashes enforced against the pinned index, with one exception: the root of
a source-built package, acquired through `acquire-source`, carries no
index hash, because no index served it — its build script and its build
record are its provenance. Every dependency of a source-built package
keeps the hashes-enforced rule. The run MUST publish no advertised
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

#### Scenario: A source-built root trades its hash for its record

- **GIVEN** a source-built package committed through `acquire-source`
- **WHEN** its store directory is inspected
- **THEN** it carries no index hash for its root, its build record names the source and the script, and each dependency of it carries its index hash

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

The two candidates MUST be identity keys. The shared fixture
`harness/src/sandbox/__fixtures__/package-identity.json` MUST carry that
outcome under `both_hit_report`. The provisioner suite and the host suite
MUST both read that case, thus the two sides of the wire cannot drift.

#### Scenario: A both-hit name asks instead of guessing

- **GIVEN** a request for a name that PyPI and CRAN both hold, with no track given
- **WHEN** the acquire run resolves it
- **THEN** the outcome is a both-hit refusal with the two identities, and nothing installs

#### Scenario: The candidates are identities

- **GIVEN** an unqualified request `igraph` that PyPI and CRAN both hold
- **WHEN** the acquire run reports the both-hit
- **THEN** the candidates are `python:igraph` and `r:igraph`

#### Scenario: One fixture case binds the two sides of the wire

- **GIVEN** the fixture case `both_hit_report`
- **WHEN** the provisioner suite and the host suite run
- **THEN** each suite asserts that case, and a side that answers otherwise fails its suite

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

`reclaim --debris` MUST also remove the stale reports under
`.inflexa-download/`: the acquire reports and the source-build reports.
It MUST NOT change the graph. The host owns the triggers of the debris
pass, and it gates them on live work.

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

#### Scenario: The debris pass removes a stale source report

- **GIVEN** a `source-*.json` report that a stopped host process left behind
- **WHEN** `reclaim --debris` runs
- **THEN** the report file is gone

### Requirement: A source build runs one script over one snapshot

`acquire-source` MUST accept a pristine source snapshot (a git work tree
at the pinned commit, or a copy of a local folder) and one build script.
The script contract is fixed. The script MUST build exactly one root
artifact into a named output directory of the container. The artifact is
one installed R package directory with its `DESCRIPTION`, or one built
wheel. The script MUST NOT install the dependencies of the package.

The dependency order follows the track, because each ecosystem builds
differently. For R, the run MUST resolve the dependencies of the package
tree first, with a pak lockfile resolve. It MUST install them before it
runs the script. `R CMD INSTALL` refuses a package whose imports are absent.
The package tree is the snapshot root, or the package directory that the
run receives. For Python, the script builds the wheel first, and the run
then resolves the wheel's requirements and installs them through the
hash-pinned path.

The run MUST refuse a package directory that is absolute, that holds a
`..` segment, that resolves outside the snapshot, or that holds no
`DESCRIPTION`.

The run MUST refuse a script whose output directory holds no artifact or
more than one. The name and the version of the root MUST come from the
package metadata: `Package` and `Version` of the DESCRIPTION for R, and
the `.dist-info` of the wheel for Python. Each edge of the new node MUST
point to a pool node or to an image-owned name, or the run refuses. The
root's own name MUST NOT enter the staged dependency set.

A failure of a dependency install MUST refuse the run, for each track.
The refusal MUST remove each store directory that the run made, and the
run MUST write its report with the reason.

#### Scenario: A clean script builds what the session built

- **GIVEN** a build script that the session proved, and the pristine snapshot it was proved against
- **WHEN** `acquire-source` runs the script in a fresh container
- **THEN** the root artifact lands in the pool as a normal content-addressed store directory, and its dependencies install through the hash-pinned paths

#### Scenario: The R dependencies install before the script runs

- **GIVEN** an R source package whose imports CRAN serves
- **WHEN** `acquire-source` runs
- **THEN** the pak lockfile resolve of the snapshot tree installs the imports first, and the script's install of the root then succeeds

#### Scenario: The package directory feeds the R resolve

- **GIVEN** a snapshot whose R package lives under `pkg/`, and the package directory `pkg`
- **WHEN** `acquire-source` runs
- **THEN** the pak resolve reads `pkg/DESCRIPTION`, and the imports install before the script runs

#### Scenario: A package directory outside the snapshot is refused

- **GIVEN** the package directory `../etc`
- **WHEN** `acquire-source` runs
- **THEN** the run refuses before any install, and the report names the directory

#### Scenario: The run refuses a script that builds nothing

- **GIVEN** a build script whose run leaves no artifact in the output directory
- **WHEN** `acquire-source` runs it
- **THEN** the run refuses, the pool holds no new store directory, and the refusal names the missing artifact

#### Scenario: A script that installs dependencies itself does not pass

- **GIVEN** a build script that runs its own dependency install into the output directory
- **WHEN** `acquire-source` inspects the output
- **THEN** the run refuses the extra artifacts beside the root, because the dependencies belong to the hash-pinned path

#### Scenario: A dependency that resolves to nothing stops the run

- **GIVEN** a source package whose dependency resolves to no pool node and no image-owned name
- **WHEN** `acquire-source` stages the graph nodes
- **THEN** the run refuses and names the edge

#### Scenario: The root never stages as its own dependency

- **GIVEN** a pool that already holds the index build of the root's name
- **WHEN** `acquire-source` resolves the dependencies of the snapshot tree
- **THEN** the staged set holds the dependencies alone, and the index build of the root's name joins no stage

#### Scenario: A failed Python dependency install refuses with a report

- **GIVEN** a built wheel whose second requirement fails to install, after the first one installed
- **WHEN** `acquire-source` installs the requirements
- **THEN** the run refuses with the reason in its report, and the store directory of the first requirement is gone

### Requirement: The build script runs unprivileged

`acquire-source` MUST install the apt packages of the plan itself, as
root, after the apt pin and before the script. Each apt package name MUST
be a Debian package name: a lowercase letter or a digit first, then
lowercase letters, digits, `+`, `-`, or `.`. The run refuses each other
name before any install.

The run MUST then execute the script as uid 1000 and gid 1000, through
`setpriv`. The script process MUST have an empty capability set, an empty
bounding set, and `no-new-privs`. The output directory MUST be writable
by uid 1000.

The script MUST NOT reach the read-write store mount. The run makes the
parent directory of the store mount readable by root alone before the
script starts. The run refuses when that parent is `/`. The script reads its R dependency library through the
read-only view of the store that the host launch mounts. The path of
that view is a required argument of the run. The links of
that library are relative.

The run MUST execute a copy of the approved script that root owns and
that uid 1000 cannot change. The run MUST write the output of the script
to a file and read only its tail, never the whole output in memory.
After the script returns, the run MUST kill each remaining process of
uid 1000 before root reads the output directory.

#### Scenario: The script cannot delete the wall

- **GIVEN** an approved script that runs `nft delete table ip inflexa-egress`
- **WHEN** `acquire-source` runs the script
- **THEN** the command fails with a permission error, and the wall stays

#### Scenario: The script cannot write the store

- **GIVEN** an approved script that writes a file under `/mnt/libs`
- **WHEN** `acquire-source` runs the script
- **THEN** the write fails, and the store is unchanged

#### Scenario: The plan's apt packages install before the script

- **GIVEN** a plan that names the apt package `libcurl4-openssl-dev`
- **WHEN** `acquire-source` runs
- **THEN** the package installs as root before the script, and the script needs no root

#### Scenario: An option is not an apt package

- **GIVEN** an apt package name `-oAPT::Get::AllowUnauthenticated=true`
- **WHEN** `acquire-source` runs
- **THEN** the run refuses before any install, and the report names the value

### Requirement: The source pin carries a qualifier and the match is exact

The pin marker of a source-built package MUST carry a source qualifier:
the full commit sha of a git source, for example
`SeedMatchR==2.0.0@git:2fc0c4f7d2be974cd8fa4f2a55a71c1a63d38b1e`, or the
first 16 hex characters of the tree hash of a local folder, for example
`SeedMatchR==2.0.0@tree:9b1deb4d3b7d4bad`. The store directory name
keeps the bare metadata version — the qualifier lives on the pin marker
alone, because the graph node version comes from the metadata and the
directory name. A store-directory lookup MUST strip the qualifier for the
directory glob and then require the full qualified marker text, thus an
index acquisition never matches a source build, a source build never
matches an index acquisition, and a repeat source build of the same
qualified pin reuses the held directory.

#### Scenario: An index acquire never reuses a source build

- **GIVEN** a pool that holds `SeedMatchR==2.0.0@git:<sha>`
- **WHEN** an `acquire` run resolves `r:SeedMatchR==2.0.0` against CRAN
- **THEN** the index install writes its own store directory, and the source build serves no link of it

#### Scenario: A source build never reuses an index package

- **GIVEN** a pool that holds the CRAN `SeedMatchR==2.0.0`
- **WHEN** a source build of the fork at commit `<sha>` commits
- **THEN** it writes its own store directory under its qualified pin

#### Scenario: A repeat source build reuses its own directory

- **GIVEN** a pool that holds `SeedMatchR==2.0.0@git:<sha>`
- **WHEN** the same source build runs again
- **THEN** the run reuses the held directory and installs nothing

### Requirement: A build record rides beside the pin

Each source-built store directory MUST carry a build record beside the pin
and hash markers, for example `.inflexa-build.json`. The record MUST hold
the source: the URL and the full commit sha, or the tree hash of the
folder, and the package directory when the run received one. The record
MUST hold the digest of the provisioner image and the digest of the base
image. The host launch passes both to the run, because a process in the
container cannot read its own image digest.

The record MUST also hold the date of the apt snapshot and the apt
packages with their versions. It MUST hold the versions of the
compilers, `cmake`, R, Python, `uv`, and `pak`. It MUST hold the build
script, its sha256, and the arch.
The record MUST NOT hold a credential of the source. The record MUST stay
out of the content hash and out of every farm link, exactly like the
other markers. A local folder MUST hash through the tree-hash function of
the provisioner, because the bytes of an archive change with file times.

#### Scenario: The record names the commit

- **GIVEN** a source build of `tacazares/SeedMatchR` at commit `<sha>`
- **WHEN** the store directory is inspected
- **THEN** its build record holds the URL, the full commit sha, the build script, and the tool versions

#### Scenario: The record of a folder holds the tree hash

- **GIVEN** a source build of a local folder
- **WHEN** the store directory is inspected
- **THEN** its build record holds the tree hash of the folder, and no credential

#### Scenario: The record names the package directory

- **GIVEN** a source build whose package directory is `pkg`
- **WHEN** the store directory is inspected
- **THEN** its build record holds `pkg` beside the source

#### Scenario: The record stays out of the content address

- **GIVEN** a store directory that carries a build record
- **WHEN** the content hash and the farm links are taken
- **THEN** the record file takes part in neither

### Requirement: The link rule gates the source commit

Each ELF file of a source-built artifact MUST link statically, or link
only to libraries that the sandbox image carries. The commit MUST check
this inside the sandbox image: `ldd` over each ELF file of the staged
source-built directories, run as `R CMD ldd` for the R track so the
loader path of the R installation applies, and a `not found` line MUST
fail the commit with the missing library named. The load check alone does
not serve, because its message does not name the library.

#### Scenario: A dynamic link to an absent library fails the commit

- **GIVEN** a source-built package whose `.so` links `libfoo.so.1`, which the sandbox image does not carry
- **WHEN** the commit runs the link-rule check
- **THEN** the commit fails, and the message names `libfoo.so.1`

#### Scenario: A static link passes

- **GIVEN** a source-built package whose `.so` links statically or only to image libraries
- **WHEN** the commit runs the link-rule check
- **THEN** the check passes, and the artifact commits
