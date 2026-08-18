# lib-store Delta — Per-Analysis Cache Mount

## ADDED Requirements

### Requirement: A per-analysis cache mounts read-write beside the farm

The sandbox container MUST receive the cache of its analysis as a read-write
mount at `/mnt/libs/cache`, nested inside the read-only store mount. The store
mount and the farm mount stay read-only, thus a step cannot rewrite a package
link through the cache.

The embedder MUST resolve the cache location beside the farm location, in one
resolution from one analysis id. On Docker the location is a host path. On
Kubernetes it is a subPath under the store PVC, mounted read-write. The harness
MUST NOT derive a cache location from a naming rule of its own.

A resolution can name a farm and no cache. The sandbox then receives no cache
mount, and the run compiles into the container. That state is a degradation,
and it MUST NOT refuse the sandbox.

The cache belongs to one analysis. A load of a cache entry executes machine
code, thus a shared writable cache would let one analysis plant code that
another executes. The harness MUST NOT mount the cache of one analysis into
the sandbox of another.

A farm MUST NOT carry a cache link. The mount is what puts a cache at the
container path, thus a `numba-cache` or `matplotlib_config` link inside a farm
selects nothing.

#### Scenario: The cache mounts read-write beside the read-only farm

- **GIVEN** a resolution that names a farm and a cache
- **WHEN** a sandbox is created
- **THEN** the cache mounts read-write at `/mnt/libs/cache`, and the store and the farm stay read-only

#### Scenario: A resolution with no cache degrades and does not refuse

- **GIVEN** a resolution that names a farm and no cache
- **WHEN** a sandbox is created
- **THEN** the sandbox starts with no cache mount, and the run compiles into the container

#### Scenario: A kernel compiled by one step loads in the next step

- **GIVEN** two sequential steps of one analysis that call one kernel at one signature
- **WHEN** the second step runs
- **THEN** it loads the entry that the first step wrote, and it compiles nothing for that call

#### Scenario: Two analyses never share a writable cache

- **GIVEN** two analyses with two sandboxes
- **WHEN** each sandbox mounts its cache
- **THEN** each mounts the cache of its own analysis, and neither can write where the other reads
