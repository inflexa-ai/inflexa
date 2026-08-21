# Delta: sandbox-image-catalog

## ADDED Requirements

### Requirement: The image owns the toolchain

The image MUST own the interpreters, the conda prefix at `/opt/conda`, and
the Node packages at `/opt/node`. Builder stages install them, because a
conda prefix does not relocate and cannot join a content-addressed store.
The image MUST bake its inventory under `/opt/inflexa`, with the
`image-packages.txt` fragment that `list_available_packages` merges. The
store mount point MUST stay empty in the image.

#### Scenario: The conda tools live in the image

- **GIVEN** a running sandbox container without a store mount
- **WHEN** a baked conda tool such as `samtools` runs from `/opt/conda/bin`
- **THEN** the tool executes

#### Scenario: The inventory fragment is baked

- **WHEN** `/opt/inflexa/image-packages.txt` is read in a running container
- **THEN** it lists the image-owned tools

### Requirement: The entrypoint seeds the caches

The entrypoint MUST source the seed file and call `seed_caches` before the
firewall path and before the exec. When the read-write cache mount at
`/mnt/libs/cache` is present, the seed does nothing, because the env
already points into it. Without the mount, the seed copies `numba-cache`
and `matplotlib_config` from the farm mount at `/mnt/libs/farm` to
writable paths under `/tmp`. It then exports `NUMBA_CACHE_DIR` and
`MPLCONFIGDIR`. On arm64 it sets `NUMBA_CPU_NAME=generic`. A missing cache MUST degrade in silence,
because a cold cache costs time and not correctness.

#### Scenario: The caches seed at boot

- **GIVEN** a farm with prepared caches at `/mnt/libs/farm`
- **WHEN** the container starts
- **THEN** the caches copy to writable paths, and the two env vars point at them

#### Scenario: A farm without caches still boots

- **GIVEN** a farm with no prepared cache directories
- **WHEN** the container starts
- **THEN** the entrypoint continues, and the sandbox serves

## MODIFIED Requirements

### Requirement: Single base image Dockerfile location

The base image Dockerfile MUST be at `images/sandbox-base/Dockerfile`. The
subdirectories of `images/` MUST be `sandbox-base/`, `sandbox-provisioner/`,
and `package-store/` (the manifest, the per-arch locks, and the warm
scripts), and no other. A variant-image directory MUST NOT exist.

#### Scenario: Dockerfile locations

- **GIVEN** the `images/` directory
- **WHEN** listing its subdirectories
- **THEN** it contains `sandbox-base/` and `sandbox-provisioner/`, each with a `Dockerfile`, and `package-store/` with the manifest
