# lib-store-build Delta — Per-Analysis Cache Mount

## MODIFIED Requirements

### Requirement: Cache preparation is verified to take effect at run time

The build MUST make sure that the runtime uses a prepared cache, and that the
cache is not merely present on disk. It MUST run a workload that exercises code
which compiles at the first call. It MUST run that workload as the unprivileged
runtime user. It MUST load every cache entry that the preparation run recorded.
A run that writes a new cache entry for a prepared code path MUST fail the
check.

The seed file of the image MUST export the cache env at the mounted cache, and
it MUST copy no file. numba selects a cache directory by a write probe, and the
read-write mount passes that probe. A seed that copies would prove a mechanism
that no sandbox runs. When no cache is mounted, the seed MUST export nothing,
and the run compiles into the container.

The check MUST read the mounted arrangement: a cache seeded from the catalog
entries, mounted read-write at the container path, beside a read-only farm.
The seed of the check MUST hardlink the numba entries and copy the matplotlib
directory, because that is the seed rule of the embedder. A check against a
copied cache in `/tmp` proves a shape that no analysis uses.

A write outside the recorded set MUST NOT fail the check. Such a write names a
kernel that the preparation could not cache, and no workload can prevent it.

The presence of cache files MUST NOT count as evidence that the cache is
effective.

The build MUST prepare the caches before it runs that check. The preparation
step MUST mount the target farm at the container path that the sandbox imports
from. The manifest MUST declare the workload, and the build MUST pass it to the
provisioner with no list of its own.

The build MUST run the R load check in the sandbox runtime image, against the
farm that it published. A failure MUST stop the build before it publishes the
catalog artifact.

#### Scenario: An effective prepared cache passes through the mount

- **GIVEN** a cache seeded from the catalog entries and mounted read-write
- **WHEN** the verification workload runs
- **THEN** the check observes a load for each recorded entry, and it passes

#### Scenario: A seed that copies nothing still serves each entry

- **WHEN** the check runs
- **THEN** the seed file exports the mounted paths, copies no file, and each recorded entry loads

#### Scenario: A run-time write lands in the mounted cache

- **GIVEN** a workload that compiles a kernel outside the recorded set
- **WHEN** the run finishes
- **THEN** the new entry is in the mounted cache, and the catalog directories are unchanged

#### Scenario: An ineffective prepared cache fails the build

- **GIVEN** a store whose caches sit where the runtime cannot read them
- **WHEN** the verification workload runs
- **THEN** the check observes cache writes at run time and fails
