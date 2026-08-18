# farm-composition Delta — Per-Analysis Warm Caches

## REMOVED Requirements

### Requirement: The warm caches link from the catalog template

## ADDED Requirements

### Requirement: Each analysis owns a seeded warm cache

The CLI MUST make `farm-caches/<analysisId>` under the store root, beside the
farms. The creation MUST happen at sandbox creation, beside the step tree,
because that code holds the engine fact that decides the permissions. Under an
engine that presents honest host ownership, the directory MUST take the mode
that the sandbox user can write.

The seed MUST hardlink the numba entries of the catalog, with the directory
structure preserved. The seed MUST copy the matplotlib directory, and it MUST
NOT hardlink it, because matplotlib writes its font cache in place. When a
hardlink fails, the seed MUST fall back to a copy of that entry.

A farm MUST NOT carry a cache link. The mount of the harness puts the cache at
the container path, thus a link inside the farm selects nothing.

The catalog directories are the seed source, and only the build of the catalog
writes them. A seed MUST NOT modify a catalog directory, and a run of an
analysis MUST NOT reach a catalog inode through the seeded cache.

#### Scenario: A cache is made and seeded at the first sandbox

- **GIVEN** an analysis with no cache directory
- **WHEN** a sandbox of the analysis is created
- **THEN** `farm-caches/<analysisId>` exists, seeded from the catalog, and the sandbox user can write it

#### Scenario: The numba seed costs no bytes

- **WHEN** the seed links the numba entries
- **THEN** each seeded file shares the inode of its catalog source

#### Scenario: A run writes beside the seed, and the catalog survives

- **GIVEN** a seeded cache and a run that compiles a new kernel
- **WHEN** the run writes its entries
- **THEN** the new entries land in the cache of the analysis, and each catalog inode is unchanged

#### Scenario: A composed farm carries no cache link

- **WHEN** composition or an extension writes a farm
- **THEN** the farm holds packages and markers only, and no `numba-cache` or `matplotlib_config` link

### Requirement: A warm cache dies with its analysis

`analysis delete` MUST remove `farm-caches/<analysisId>` in the stage that
removes the farm, behind the same lease check. The orphan reaper of the
reclamation MUST remove a cache whose analysis id the database does not hold.
The reaper MUST NOT touch the catalog directories.

#### Scenario: Deleting the analysis removes the cache

- **GIVEN** an analysis with a farm and a cache, and no live sandbox
- **WHEN** `analysis delete` runs
- **THEN** the farm and the cache are removed, and the catalog is untouched

#### Scenario: The reaper removes an orphan cache

- **GIVEN** a cache whose analysis id is not in the database
- **WHEN** reclamation runs
- **THEN** the reaper removes the cache, beside the orphan farms
