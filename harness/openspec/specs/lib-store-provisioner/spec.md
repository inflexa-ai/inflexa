# lib-store-provisioner Specification

## Purpose

The provisioner is the network-enabled container that builds the content-addressed
package store and the per-analysis farms. It resolves a dependency closure,
installs each distribution, content-addresses the result, assembles the farm,
prepares the caches, and exits. The sandbox never gains what the provisioner has:
no network reaches a sandbox, and the store mounts read-only.

## Requirements

### Requirement: Provisioning runs in a container separate from the sandbox

Package provisioning MUST run in a dedicated container that is distinct from any sandbox. The provisioner can have network access, and it MUST carry a build toolchain. It MUST mount the library store. It MUST NOT mount any analysis workspace, session tree, or reference store. Thus it holds no user data while it has a network. It MUST exit when provisioning completes.

The sandbox MUST remain unchanged: no network, uid 1000, all capabilities dropped, and the store mounted read-only.

#### Scenario: The provisioner reaches the network but sees no user data

- **WHEN** a provisioning run starts
- **THEN** the container has network access, and the only host path mounted into it is the library store root

#### Scenario: The sandbox posture is unaffected

- **GIVEN** a store assembled by the provisioner
- **WHEN** a sandbox is created against it
- **THEN** the sandbox has no network, runs as uid 1000 with all capabilities dropped, and mounts the store read-only

### Requirement: The provisioner is built from the sandbox runtime's base image

The provisioner image MUST be built from the same digest-pinned base image as `sandbox-base`. The sandbox loads the compiled artifacts that the provisioner produces. Thus a divergent base would give a mismatched libc, C++ runtime, or Python ABI.

#### Scenario: Base images match

- **WHEN** the provisioner image is built
- **THEN** its base image digest equals the one `sandbox-base` is built from

#### Scenario: A compiled package loads in the sandbox

- **GIVEN** a package with no prebuilt wheel for the target architecture
- **WHEN** the provisioner compiles and stores it
- **THEN** the sandbox imports it successfully

### Requirement: Each distribution is stored once, addressed by its content

The provisioner MUST install each resolved distribution into its own directory under `<root>/store/`. The name of that directory comes from the distribution name, its version, and a hash of the installed content. A directory MUST be written once and never modified in place. When a resolved distribution already has a store directory, the provisioner MUST reuse that directory rather than install the distribution again.

The content hash MUST cover file contents, relative paths, the executable bit, and symbolic-link targets. It MUST exclude derived artifacts — compiled Python bytecode and prepared JIT caches — so that cache preparation does not invalidate the address.

Publication MUST be atomic. The provisioner MUST stage an install inside the store. It MUST move the install into place with a rename. Thus an interrupted run leaves no partially written store directory.

#### Scenario: A shared dependency is stored once

- **GIVEN** two analyses whose closures both resolve numpy to the same version
- **WHEN** both are provisioned
- **THEN** the store holds exactly one directory for that numpy version, and both closures reference it

#### Scenario: Cache preparation does not change the address

- **GIVEN** a stored distribution
- **WHEN** cache preparation writes bytecode or JIT artifacts beneath it
- **THEN** its content address is unchanged and it is still reused

#### Scenario: An interrupted run leaves no partial directory

- **WHEN** the provisioner is stopped during an install
- **THEN** no partially written directory exists under `<root>/store/`, and a subsequent run completes the install

### Requirement: Source artifacts are pinned by hash and resolved from a pinned index

The provisioner MUST resolve a dependency closure to exact versions and MUST record a cryptographic hash for each source artifact it downloads. It MUST refuse an artifact whose hash does not match the recorded value. It MUST resolve from an explicitly configured package index and MUST refuse an artifact served from an unexpected host.

#### Scenario: A tampered artifact is refused

- **GIVEN** a lock file recording a hash for a distribution
- **WHEN** the index serves an artifact whose hash differs
- **THEN** the provisioner fails and installs nothing

#### Scenario: The closure is fully pinned

- **WHEN** a provisioning run resolves a closure
- **THEN** every distribution in it is pinned to an exact version with a recorded source hash

### Requirement: An analysis reaches its closure through a symlink farm

The provisioner MUST assemble, for each analysis, a directory of symbolic links that point into the store. It MUST expose that directory at the path the sandbox already expects. Link targets MUST be paths that resolve inside the sandbox container, not host paths.

The provisioner MUST make a link for each top-level entry, and not for each file. Thus a distribution's package directory and its vendored shared-library directory resolve within the same store directory. As a result, the `$ORIGIN`-relative lookups continue to work.

When two distributions carry the same top-level name, the provisioner MUST make a real directory at that name. It MUST link both sides beneath that directory.

A farm MUST expose only the closure of its own analysis.

A farm MUST publish atomically, with its records. The provisioner MUST
assemble a new farm and its records in a staging path that no consumer
resolves. It MUST swap the staging farm into place in one step. After any
stop or crash, the farm path MUST hold either the previous complete farm or
the new complete farm, each with its records. A repair pass MUST clear the
staging debris at the start of the next run.

#### Scenario: A stopped run does not destroy the records of a farm

- **GIVEN** a farm with its records
- **WHEN** a re-provisioning run stops at any point
- **THEN** the farm path holds a complete farm with its records, old or new

#### Scenario: Links resolve inside the sandbox

- **WHEN** a farm is assembled
- **THEN** every link target is a path under the store's in-container mount point, and every link resolves in the sandbox

#### Scenario: Vendored shared libraries load

- **GIVEN** a distribution whose compiled extension loads a bundled library through an `$ORIGIN`-relative path
- **WHEN** it is imported through the farm
- **THEN** the import succeeds

#### Scenario: A shared top-level name is merged

- **GIVEN** two distributions that both carry the top-level name `mpl_toolkits`
- **WHEN** the farm is assembled
- **THEN** `mpl_toolkits` is a real directory that holds links from both distributions

#### Scenario: Farms are isolated from each other

- **GIVEN** two farms whose closures pin different versions of the same distribution
- **WHEN** each is used
- **THEN** each resolves the version its own closure pinned

### Requirement: Prepared caches are written to a relocatable directory and seeded before use

The provisioner MUST prepare the numba JIT cache and the matplotlib font cache
into directories that it publishes with the farm. It MUST NOT write them into the
installed package trees. The sandbox MUST copy those directories to writable
paths. It MUST point `NUMBA_CACHE_DIR` and `MPLCONFIGDIR` at the copies before a
workload runs. A cache for another library MUST arrive only by an amendment of
this requirement, thus the prepared set stays enumerable.

Cache preparation MUST run against the same container path that the sandbox
imports from, because a cache key holds the source path. Preparation MUST execute
a workload, and it MUST NOT import modules only, because a call starts a
compilation and an import does not. The provisioner MUST record the workload that
it executed. The effectiveness check MUST replay exactly that recording, because
another workload exercises an unprepared call signature.

The run MUST also record the cache entries that it prepared. A kernel whose
signature holds a type that cannot pickle never matches its index again. Thus it
writes on each run, and it loads on none. The check judges the recorded entries
only, thus such a kernel cannot fail it.

The invoker of the provisioner MUST mount the target farm at that container path
for the run. The store carries no pointer, thus no other mechanism puts the farm
there. A preparation run that cannot resolve the farm at that path MUST fail, and
it MUST name the mount that it wants. A cache that the run writes through another
path never loads, thus such a run produces nothing.

A module of the declared workload that does not import, and a workload script
that exits non-zero, MUST fail the run. The declaration states which packages an
analysis reaches first. Thus a module that cannot run is a broken catalog, and
not a cache that is one entry short.

#### Scenario: A prepared cache is used rather than rebuilt

- **GIVEN** a farm whose cache the provisioner prepared by a workload
- **WHEN** the sandbox runs that same workload
- **THEN** the run loads every recorded entry, and it writes none of them

#### Scenario: A kernel that cannot cache does not fail the check

- **GIVEN** a workload that reaches a kernel whose signature holds a type that cannot pickle
- **WHEN** the run prepares the caches
- **THEN** that kernel enters no record, thus its write at replay time fails nothing

#### Scenario: Preparation uses the path the sandbox will use

- **WHEN** the provisioner prepares caches for a farm
- **THEN** it does so through the same path at which the sandbox resolves the farm

#### Scenario: A run with no farm mount fails

- **GIVEN** an invoker that mounts the store root and mounts no farm at the container path
- **WHEN** a preparation run starts
- **THEN** the run fails, it names the mount that it wants, and it writes no cache

#### Scenario: The declared workload reaches the run

- **GIVEN** a manifest that names the modules and the workload script
- **WHEN** the provisioner prepares the caches of the farm
- **THEN** it runs exactly that workload, and it records it for the effectiveness check

#### Scenario: A module of the workload that does not import fails the run

- **GIVEN** a declared workload whose module the farm cannot import
- **WHEN** the preparation run reaches that module
- **THEN** the run fails and names the module, rather than preparing the modules that remain

### Requirement: R packages are stored and farmed like Python distributions

The provisioner MUST store each R package in its own content-addressed directory.
It MUST assemble the R farms at the three paths that the resolver env names.
Where the installer writes many packages into one library tree, the provisioner
MUST split that tree into one directory for each package. It MUST take the name
and the version from the `DESCRIPTION` of each package.

Each stored R package MUST record the R version. It MUST record the Bioconductor
release where one applies, because Bioconductor couples its release to an R
version. A package that compiles against the headers of another package MUST stay
recorded with that package, thus the pair stays consistent.

The load check MUST run inside the sandbox runtime image. It MUST resolve each
package through the `R_LIBS_SITE` paths of the farm, and it MUST add no other
library. The provisioner cannot start a container, thus the check belongs to the
invoker of the provisioner, and it runs after the farm publishes.

The provisioner MUST record the R packages that it farmed, and the check MUST
read that record. A package whose runtime dependency the sandbox image owns MUST
carry that name in the image-owned package list.

#### Scenario: An R package loads through the farm

- **GIVEN** an R package with compiled code, stored and farmed
- **WHEN** a sandbox calls `library()` on it and invokes its compiled code
- **THEN** both succeed

#### Scenario: A combined install tree is split per package

- **GIVEN** an installer that writes many packages into one library directory
- **WHEN** the provisioner stores them
- **THEN** each package occupies its own content-addressed directory, named from its own `DESCRIPTION`

#### Scenario: The build context is recorded

- **WHEN** an R package is stored
- **THEN** its record carries the R version, and the Bioconductor release when it came from Bioconductor

#### Scenario: A dependency of the provisioner image does not satisfy the check

- **GIVEN** an R package whose runtime dependency exists in the provisioner image and in no farm
- **WHEN** the load check runs in the sandbox runtime image
- **THEN** the check fails and names that package, because that image does not carry the dependency

#### Scenario: The check reads the record of the run

- **GIVEN** a provisioning run that farmed a set of R packages and recorded it
- **WHEN** the load check runs
- **THEN** it loads exactly the recorded set, and it walks no farm to find one

### Requirement: The image-owned package list matches the sandbox image

A test MUST compare `base-packages.json` against the installed set of the sandbox
image. It MUST fail when the list names a package that the image does not own.

The emitter drops an edge into a package that the sandbox image owns, and
`base-packages.json` is that list. The two failures are not symmetric. A name
that the list omits stops the build at the edge gate, which is loud and safe. A
name in the list that the image does not own drops a real edge. The closure then
runs short, and the import fails inside the sandbox with no explanation.

#### Scenario: A stale name in the list fails the test

- **GIVEN** an image-owned package list that names a package the sandbox image does not carry
- **WHEN** the test compares the list against that image
- **THEN** the test fails and names the package

#### Scenario: A list that matches the image passes

- **GIVEN** an image-owned package list whose every name the sandbox image carries
- **WHEN** the test compares the list against that image
- **THEN** the test passes

### Requirement: Provisioning does not disturb a sandbox that is already running

Provisioning MUST take effect for sandboxes created after it, and MUST NOT attempt to change what a running sandbox sees. The provisioner MUST NOT replace the active-farm pointer while a sandbox has the store mounted. If the provisioner replaces that path, it breaks the running container's view of that path. It does not switch that view.

#### Scenario: The active pointer is not swung under a live sandbox

- **GIVEN** a sandbox with the store mounted
- **WHEN** provisioning would re-point the active farm
- **THEN** it refuses, and reports that a sandbox uses the store

#### Scenario: The next sandbox sees the new package

- **GIVEN** a package provisioned while no sandbox ran
- **WHEN** the next sandbox is created
- **THEN** the package is importable and listed in the inventory

### Requirement: Each provisioning run records the closure it produced

The provisioner MUST write a lock file for each farm. The lock file MUST record the requested specifications. It MUST also record the resolved distributions with their versions and source hashes, and the store directories that satisfy them. When provisioning runs again for an existing farm, it MUST resolve the union of the previously requested specifications and the newly requested ones.

The provisioner MUST regenerate the farm's package inventory with the shared inventory producer. Thus a store-backed inventory and a baked inventory are indistinguishable in shape.

The records the provisioner publishes with a farm MUST describe the farm as published, not the work of the run alone. Thus the track record and the package inventory MUST cover every preserved track, and every rebuilt track. An inventory that omits a preserved track would deny a package the sandbox can import.

#### Scenario: Adding a package preserves the earlier request

- **GIVEN** a farm provisioned with one specification
- **WHEN** provisioning runs again with a second specification
- **THEN** the resulting closure satisfies both, and the lock file records both as requested

#### Scenario: The inventory matches the baked format

- **WHEN** a farm is provisioned
- **THEN** its package inventory carries the same header and section structure the shared inventory producer produces

#### Scenario: The records cover a preserved track

- **GIVEN** a farm carrying a `python` track and an `r` track
- **WHEN** a provisioning run rebuilds only the Python track
- **THEN** the published farm's track record names both tracks, and its package inventory lists the R packages the farm still resolves

### Requirement: A provisioning run preserves the tracks it does not rebuild

A provisioning run MUST preserve every track the target farm already carries and the run does not rebuild. Thus the published farm MUST hold the union of two sets: the tracks the run built, and the tracks the previous farm carried. A run MUST NOT install a preserved track again, and MUST NOT reach a network for one.

A run that builds a track MUST replace that track in the published farm. A run that builds no track of a given kind MUST keep the previous track of that kind unchanged. A removal of a track MUST be an explicit operation, which is the removal of the farm. A removal MUST NOT be a side effect of an added package.

Preservation MUST take effect through the same staging path the atomic publish already uses. Thus a stop or a crash leaves the farm path with one complete farm, old or new.

#### Scenario: Adding a Python package keeps the R track

- **GIVEN** a farm carrying a `python` track and an `r` track
- **WHEN** a provisioning run adds one Python specification and builds no R track
- **THEN** the published farm still resolves every R package it resolved before, through the same three R paths

#### Scenario: A rebuilt track replaces the preserved one

- **GIVEN** a farm carrying an `r` track
- **WHEN** a provisioning run builds the R track again
- **THEN** the published farm carries the newly built R track, not the previous one

#### Scenario: Preservation costs no reinstall and no network

- **GIVEN** a farm carrying a track the run does not rebuild
- **WHEN** the run publishes the farm
- **THEN** it installs no package for that track and makes no network request for it

#### Scenario: A stopped run leaves one complete farm

- **GIVEN** a farm carrying two tracks
- **WHEN** a provisioning run stops before it publishes
- **THEN** the farm path still resolves both tracks, and no track is lost
