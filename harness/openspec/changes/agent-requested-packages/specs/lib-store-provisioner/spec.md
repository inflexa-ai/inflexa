# lib-store-provisioner Specification

## ADDED Requirements

### Requirement: The dependency graph records a version ordering

The emitter MUST record, for each canonical distribution name, the store
directories of that name in order. The newest MUST come first. A consumer that
names no version MUST take the head of that list.

The emitter MUST do this ordering, and a host MUST NOT do it again. Neither
ecosystem uses semantic versioning. Python uses PEP 440, with epochs,
pre-releases, post-releases, and local versions. R uses a dotted-decimal form.
Thus a sort of the text is wrong, because `1.10.3` sorts before `1.9.0`.

The emitter runs inside the provisioner image, where the version libraries of
both ecosystems already are. A second implementation on the host would be one
rule in two places, and two such places drift.

A pre-release MUST NOT be the head while a release of that name exists. A caller
that wants a pre-release MUST name its version.

#### Scenario: The newest version is the head

- **GIVEN** a pool that holds three versions of one distribution
- **WHEN** the emitter writes the graph
- **THEN** the entry of that name lists the three store directories, newest first

#### Scenario: A numeric segment orders correctly

- **GIVEN** a pool that holds version 1.9.0 and version 1.10.3 of one distribution
- **WHEN** the emitter writes the graph
- **THEN** 1.10.3 is the head, because the order is numeric and not alphabetic

#### Scenario: A pre-release is not the head

- **GIVEN** a pool that holds version 2.0 and version 2.1rc1 of one distribution
- **WHEN** the emitter writes the graph
- **THEN** version 2.0 is the head, and version 2.1rc1 follows it

## MODIFIED Requirements

### Requirement: Prepared caches are written to a relocatable directory and seeded before use

The provisioner MUST prepare the numba JIT cache and the matplotlib font cache
into directories that it publishes with the store. It MUST NOT write them into
the installed package trees. The sandbox MUST copy those directories to writable
paths. It MUST point `NUMBA_CACHE_DIR` and `MPLCONFIGDIR` at the copies before a
workload runs. A cache for another library MUST arrive only by an amendment of
this requirement, thus the prepared set stays enumerable.

A prepared cache MUST have one home, and every farm MUST link that home. The
catalog template farm is that home, and each analysis farm links its cache
directories there. A cache key holds the container path of the source, and every
farm resolves one distribution at one container path. Thus one preparation serves
each farm that links the package.

An acquisition run MUST warm into that home, and not into the farm that it bound
for the run. The import path sets the cache key, and the cache path sets where an
entry lands. Thus the run binds a farm that holds the new package, and it points
the cache at the home.

Cache preparation MUST run against the same container path that the sandbox
imports from, because a cache key holds the source path. Preparation MUST execute
a workload, and it MUST NOT import modules only, because a call starts a
compilation and an import does not. The provisioner MUST record the workload that
it executed. The effectiveness check MUST replay exactly that recording, because
another workload exercises an unprepared call signature.

An acquisition run MUST prepare what it acquired. A distribution that reaches the
pool after the catalog build would otherwise carry no prepared entry. Thus its
compiled kernels build again at each first call, on each machine.

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

#### Scenario: One preparation serves two farms

- **GIVEN** two analysis farms that link one store directory
- **WHEN** each mounts its own farm and runs the prepared workload
- **THEN** both load the entries of that store directory, and neither prepares them again

#### Scenario: An acquisition prepares what it acquired

- **GIVEN** an acquisition run that adds a distribution to the pool
- **WHEN** the run completes
- **THEN** the shared cache home holds the prepared entries of that distribution

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
