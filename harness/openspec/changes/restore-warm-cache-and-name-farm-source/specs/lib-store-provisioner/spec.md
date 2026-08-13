# lib-store-provisioner Specification

## MODIFIED Requirements

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

## ADDED Requirements

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
