## MODIFIED Requirements

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

## ADDED Requirements

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
