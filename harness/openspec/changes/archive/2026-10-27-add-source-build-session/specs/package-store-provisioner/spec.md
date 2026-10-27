# Spec Delta

## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: A source build runs one script over one snapshot

`acquire-source` MUST accept a pristine source snapshot (a git work tree
at the pinned commit, or a copy of a local folder) and one build script.
The script contract is fixed: the script MUST build exactly one root
artifact — one installed R package directory with its `DESCRIPTION`, or
one built wheel — into a named output directory of the container, and it
MUST NOT install the dependencies of the package. The dependency order
follows the track, because each ecosystem builds differently: for R, the
run MUST resolve the dependencies of the snapshot tree first — a pak
lockfile resolve of the local tree — and install them before it runs the
script, because `R CMD INSTALL` refuses a package whose imports are
absent; for Python, the script builds the wheel first (a wheel build
needs no runtime dependencies), and the run then resolves the wheel's
requirements and installs them through the hash-pinned path. The run
refuses a script whose output directory holds no artifact or more than
one. The name and the version of the root MUST come from the package
metadata: `Package` and `Version` of the DESCRIPTION for R, and the
`.dist-info` of the wheel for Python. Each edge of the new node MUST
point to a pool node or to an image-owned name, or the run refuses, and
the root's own name MUST NOT enter the staged dependency set.

#### Scenario: A clean script builds what the session built

- **GIVEN** a build script that the session proved, and the pristine snapshot it was proved against
- **WHEN** `acquire-source` runs the script in a fresh container
- **THEN** the root artifact lands in the pool as a normal content-addressed store directory, and its dependencies install through the hash-pinned paths

#### Scenario: The R dependencies install before the script runs

- **GIVEN** an R source package whose imports CRAN serves
- **WHEN** `acquire-source` runs
- **THEN** the pak lockfile resolve of the snapshot tree installs the imports first, and the script's install of the root then succeeds

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
the source (the URL and the full commit sha, or the tree hash of the
folder), the digest of the provisioner image and the digest of the base
image (both passed to the run by the host launch, because a process in the
container cannot read its own image digest), the date of the apt snapshot
and the apt packages with their versions, the versions of the compilers,
`cmake`, R, Python, `uv`, and `pak`, the build script and its sha256, and
the arch. The record MUST NOT hold a credential of the source. The record
MUST stay out of the content hash and out of every farm link, exactly like
the other markers. A local folder MUST hash through the tree-hash function
of the provisioner, because the bytes of an archive change with file times.

#### Scenario: The record names the commit

- **GIVEN** a source build of `tacazares/SeedMatchR` at commit `<sha>`
- **WHEN** the store directory is inspected
- **THEN** its build record holds the URL, the full commit sha, the build script, and the tool versions

#### Scenario: The record of a folder holds the tree hash

- **GIVEN** a source build of a local folder
- **WHEN** the store directory is inspected
- **THEN** its build record holds the tree hash of the folder, and no credential

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
