# lib-store-build Specification

## MODIFIED Requirements

### Requirement: Cache preparation is verified to take effect at run time

The build MUST make sure that the runtime uses a prepared cache, and that the
cache is not merely present on disk. It MUST run a workload that exercises code
which compiles at the first call. It MUST run that workload as the unprivileged
runtime user, against the read-only store. It MUST load every cache entry that
the preparation run recorded. A run that writes a new cache entry for a prepared
code path MUST fail the check.

A write outside the recorded set MUST NOT fail the check. Such a write names a
kernel that the preparation could not cache, and no workload can prevent it.

The presence of cache files MUST NOT count as evidence that the cache is
effective.

The build MUST prepare the caches before it runs that check. A build that
prepares nothing publishes a store with no cache, thus the check has nothing to
prove. The preparation step MUST mount the target farm at the container path that
the sandbox imports from.

The manifest MUST declare the workload. The build MUST read that declaration and
pass it to the provisioner, and it MUST NOT carry a list of its own. Thus the
workload and the packages that it exercises change in one file.

The build MUST run the R load check in the sandbox runtime image, against the
farm that it published. A failure MUST stop the build before it publishes the
catalog artifact, because that artifact is the publish which reaches a user.

#### Scenario: An ineffective prepared cache fails the build

- **GIVEN** a store whose caches sit where the runtime cannot read them
- **WHEN** the verification workload runs
- **THEN** the check observes cache writes at run time and fails

#### Scenario: An effective prepared cache passes

- **GIVEN** a store whose caches sit where the runtime reads them
- **WHEN** the verification workload runs
- **THEN** the check observes a load for each recorded entry, and it passes

#### Scenario: A write outside the recorded set passes

- **GIVEN** a workload that reaches a kernel which the preparation could not cache
- **WHEN** the verification workload runs
- **THEN** the check reports that write, and it passes because the entry is in no record

#### Scenario: A build that prepares no cache fails

- **GIVEN** a build that publishes a store and runs no preparation step
- **WHEN** the verification workload runs
- **THEN** the check observes cache writes at run time and fails

#### Scenario: The workload comes from the manifest

- **GIVEN** a manifest that names the modules and the workload script
- **WHEN** the build prepares the caches
- **THEN** it reads that declaration, passes it to the provisioner, and names no module of its own

#### Scenario: An R package that the runtime image cannot load stops the build

- **GIVEN** a published farm holding an R package that does not load in the sandbox runtime image
- **WHEN** the build runs the load check in that image
- **THEN** the build fails and publishes no catalog artifact
