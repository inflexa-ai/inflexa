## ADDED Requirements

### Requirement: Provisioning runs in a container separate from the sandbox

Package provisioning SHALL run in a dedicated container that is distinct from any sandbox. The provisioner MAY have network access and SHALL carry a build toolchain. It SHALL mount the library store and SHALL NOT mount any analysis workspace, session tree, or reference store, so that it holds no user data while it has a network. It SHALL exit when provisioning completes.

The sandbox SHALL remain unchanged: no network, uid 1000, all capabilities dropped, and the store mounted read-only.

#### Scenario: The provisioner reaches the network but sees no user data

- **WHEN** a provisioning run starts
- **THEN** the container has network access, and the only host path mounted into it is the library store root

#### Scenario: The sandbox posture is unaffected

- **GIVEN** a store assembled by the provisioner
- **WHEN** a sandbox is created against it
- **THEN** the sandbox has no network, runs as uid 1000 with all capabilities dropped, and mounts the store read-only

### Requirement: The provisioner is built from the sandbox runtime's base image

The provisioner image SHALL be built from the same digest-pinned base image as `sandbox-base`. Compiled artifacts produced by the provisioner are loaded by the sandbox, so a divergent base would yield a mismatched libc, C++ runtime, or Python ABI.

#### Scenario: Base images match

- **WHEN** the provisioner image is built
- **THEN** its base image digest equals the one `sandbox-base` is built from

#### Scenario: A compiled package loads in the sandbox

- **GIVEN** a package with no prebuilt wheel for the target architecture
- **WHEN** the provisioner compiles and stores it
- **THEN** the sandbox imports it successfully

### Requirement: Each distribution is stored once, addressed by its content

The provisioner SHALL install each resolved distribution into its own directory under `<root>/store/`, named from the distribution name, its version, and a hash of the installed content. A directory SHALL be written once and never modified in place. When a resolved distribution already has a store directory, the provisioner SHALL reuse it rather than install it again.

The content hash SHALL cover file contents, relative paths, the executable bit, and symbolic-link targets. It SHALL exclude derived artifacts — compiled Python bytecode and prepared JIT caches — so that cache preparation does not invalidate the address.

Publication SHALL be atomic. The provisioner SHALL stage an install inside the store and SHALL move it into place with a rename, so that an interrupted run leaves no partially written store directory.

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

The provisioner SHALL resolve a dependency closure to exact versions and SHALL record a cryptographic hash for each source artifact it downloads. It SHALL refuse an artifact whose hash does not match the recorded value. It SHALL resolve from an explicitly configured package index and SHALL refuse an artifact served from an unexpected host.

#### Scenario: A tampered artifact is refused

- **GIVEN** a lock file recording a hash for a distribution
- **WHEN** the index serves an artifact whose hash differs
- **THEN** the provisioner fails and installs nothing

#### Scenario: The closure is fully pinned

- **WHEN** a provisioning run resolves a closure
- **THEN** every distribution in it is pinned to an exact version with a recorded source hash

### Requirement: An analysis reaches its closure through a symlink farm

The provisioner SHALL assemble, for each analysis, a directory of symbolic links pointing into the store, and SHALL expose it at the path the sandbox already expects. Link targets SHALL be paths that resolve inside the sandbox container, not host paths.

Links SHALL be created per top-level entry rather than per file, so that a distribution's package directory and its vendored shared-library directory resolve within the same store directory and `$ORIGIN`-relative lookups continue to work.

When two distributions provide the same top-level name, the provisioner SHALL create a real directory at that name and link both sides beneath it.

A farm SHALL expose only the closure of its own analysis.

#### Scenario: Links resolve inside the sandbox

- **WHEN** a farm is assembled
- **THEN** every link target is a path under the store's in-container mount point, and every link resolves in the sandbox

#### Scenario: Vendored shared libraries load

- **GIVEN** a distribution whose compiled extension loads a bundled library through an `$ORIGIN`-relative path
- **WHEN** it is imported through the farm
- **THEN** the import succeeds

#### Scenario: A shared top-level name is merged

- **GIVEN** two distributions that both provide the top-level name `mpl_toolkits`
- **WHEN** the farm is assembled
- **THEN** `mpl_toolkits` is a real directory containing links from both distributions

#### Scenario: Farms are isolated from each other

- **GIVEN** two farms whose closures pin different versions of the same distribution
- **WHEN** each is used
- **THEN** each resolves the version its own closure pinned

### Requirement: Prepared caches are written to a relocatable directory and seeded before use

The provisioner SHALL prepare the numba JIT cache and the matplotlib font cache into directories it publishes with the farm, rather than into the installed package trees. The sandbox SHALL copy those directories to writable paths and point `NUMBA_CACHE_DIR` and `MPLCONFIGDIR` at the copies before any workload runs. A cache for another library SHALL be added only by amending this requirement, so the prepared set stays enumerable and testable.

Cache preparation SHALL run against the same container path the sandbox will import from, because cache validity is keyed on the source path. Preparation SHALL execute a workload rather than only importing modules, because compilation is triggered by a call rather than by an import. The provisioner SHALL record the workload it executed, and the effectiveness check SHALL replay exactly that recording — anything else tests an unprepared call signature and fails for the wrong reason.

#### Scenario: A prepared cache is used rather than rebuilt

- **GIVEN** a farm whose cache was prepared by executing a workload
- **WHEN** the sandbox runs that same workload
- **THEN** the run loads cached compilations and writes no new cache entry

#### Scenario: Preparation uses the path the sandbox will use

- **WHEN** the provisioner prepares caches for a farm
- **THEN** it does so through the same path at which the sandbox will resolve the farm

### Requirement: R packages are stored and farmed like Python distributions

The provisioner SHALL store each R package in its own content-addressed directory and SHALL assemble the R farms at the three paths the resolver env already names. Where the installer produces a combined library tree rather than one package at a time, the provisioner SHALL split that tree into one directory per package, taking the name and version from each package's `DESCRIPTION`.

Each stored R package SHALL record the R version and, where applicable, the Bioconductor release it was built against, because Bioconductor couples its release to an R version. A package compiled against another package's headers SHALL be recorded together with that package, so the pair stays consistent.

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

### Requirement: Provisioning does not disturb a sandbox that is already running

Provisioning SHALL take effect for sandboxes created after it, and SHALL NOT attempt to change what a running sandbox sees. The provisioner SHALL NOT replace the active-farm pointer while a sandbox has the store mounted, because replacing that path breaks the running container's view of it rather than switching it.

#### Scenario: The active pointer is not swung under a live sandbox

- **GIVEN** a sandbox with the store mounted
- **WHEN** provisioning would re-point the active farm
- **THEN** it refuses, and reports that a sandbox is using the store

#### Scenario: The next sandbox sees the new package

- **GIVEN** a package provisioned while no sandbox was running
- **WHEN** the next sandbox is created
- **THEN** the package is importable and listed in the inventory

### Requirement: Each provisioning run records the closure it produced

The provisioner SHALL write a lock file for each farm recording the requested specifications, the resolved distributions with their versions and source hashes, and the store directories that satisfy them. Re-running provisioning for an existing farm SHALL resolve the union of the previously requested specifications and the newly requested ones.

The provisioner SHALL regenerate the farm's package inventory using the same producer the image build uses, so that a store-backed inventory and a baked inventory are indistinguishable in shape.

#### Scenario: Adding a package preserves the earlier request

- **GIVEN** a farm provisioned with one specification
- **WHEN** provisioning runs again with a second specification
- **THEN** the resulting closure satisfies both, and the lock file records both as requested

#### Scenario: The inventory matches the baked format

- **WHEN** a farm is provisioned
- **THEN** its package inventory carries the same header and section structure the image build produces
