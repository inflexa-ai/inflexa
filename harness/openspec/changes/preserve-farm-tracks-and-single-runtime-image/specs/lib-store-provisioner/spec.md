## ADDED Requirements

### Requirement: A provisioning run preserves the tracks it does not rebuild

A provisioning run SHALL preserve every track the target farm already carries and the run does not rebuild. Thus the published farm SHALL hold the union of two sets: the tracks the run built, and the tracks the previous farm carried. A run SHALL NOT install a preserved track again, and SHALL NOT reach a network for one.

A run that builds a track SHALL replace that track in the published farm. A run that builds no track of a given kind SHALL keep the previous track of that kind unchanged. A removal of a track SHALL be an explicit operation, which is the removal of the farm. A removal SHALL NOT be a side effect of an added package.

Preservation SHALL take effect through the same staging path the atomic publish already uses. Thus a stop or a crash leaves the farm path with one complete farm, old or new.

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

## MODIFIED Requirements

### Requirement: Each provisioning run records the closure it produced

The provisioner SHALL write a lock file for each farm recording the requested specifications, the resolved distributions with their versions and source hashes, and the store directories that satisfy them. Re-running provisioning for an existing farm SHALL resolve the union of the previously requested specifications and the newly requested ones.

The provisioner SHALL regenerate the farm's package inventory using the shared inventory producer, so that a store-backed inventory and a baked inventory are indistinguishable in shape.

The records the provisioner publishes with a farm SHALL describe the farm as published, not the work of the run alone. Thus the track record and the package inventory SHALL cover every preserved track, and every rebuilt track. An inventory that omits a preserved track would deny a package the sandbox can import.

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
