# package-store-management Specification

## Purpose

The host-side commands that create, inspect, extend, and reclaim a local package
store, and the consent model for a container that has network access. The store
itself is the harness contract. This capability is the cli surface over it.

## Requirements

### Requirement: A local package store is optional and opt-in

The CLI SHALL support a boolean configuration value that turns the host package store on. It SHALL default to off. When it is off, the CLI SHALL behave exactly as it does without this capability: no store is passed to the harness, no `/mnt/libs` bind mount is requested, no store is downloaded, and the sandbox image's baked store is used.

The store root SHALL be a fixed path the CLI owns. No configuration value SHALL name it or move it. The store-management commands, the store download, and the sandbox mount SHALL all resolve that one path. Thus a store the user populates is the store a sandbox mounts.

The store root SHALL be distinct from the per-image package-inventory cache, which is a cache keyed by image identity and not a store.

#### Scenario: An existing installation is unaffected

- **GIVEN** the store is off
- **WHEN** a sandbox launches
- **THEN** no store path is passed to the harness and the sandbox resolves imports from the image's baked store

#### Scenario: Opting in requires only the switch

- **GIVEN** a populated store on disk
- **WHEN** the user turns the store on
- **THEN** subsequent sandboxes mount the store at the CLI-owned root, with no other change required

#### Scenario: Turning the store off is a full rollback

- **GIVEN** a populated store on disk and the store turned on
- **WHEN** the user turns the store off
- **THEN** no store path is passed to the harness, although the store content stays on disk

#### Scenario: No configuration value moves the store root

- **GIVEN** a configuration file that names a store location
- **WHEN** a sandbox launches
- **THEN** the mounted root is the CLI-owned path, and the named location has no effect

#### Scenario: The store does not live in the inventory cache

- **WHEN** the store is created at its CLI-owned root
- **THEN** that root is not the directory used to cache per-image package inventories

### Requirement: Provisioning is an explicit, consented action

Any command that provisions packages SHALL require explicit user approval before it runs, because it starts a container with network access and writes to disk. Any command that deletes store content or a farm SHALL require the same approval. A command that only reads and reports SHALL NOT require approval and SHALL NOT write configuration.

#### Scenario: Provisioning asks first

- **WHEN** the user runs a command that provisions a package
- **THEN** the command requires approval before starting the provisioner

#### Scenario: Reclaiming disk asks first

- **WHEN** the user runs a command that removes unreferenced store content
- **THEN** the command requires approval, and reports what it would remove before removing it

#### Scenario: Inspection is passive

- **WHEN** the user runs a command that lists what the store holds
- **THEN** it requires no approval and writes no configuration

### Requirement: Provisioning runs through the shared container-runtime abstraction

The CLI SHALL start the provisioner through the same runtime abstraction it uses to pull images, so engine selection, readiness checking, and socket resolution are not duplicated. When no container engine is available, the command SHALL fail with the same guidance the image pull gives.

#### Scenario: The provisioner runs on the selected engine

- **GIVEN** a configured container engine
- **WHEN** provisioning runs
- **THEN** the provisioner container starts on that engine

#### Scenario: No engine gives an actionable error

- **GIVEN** no container engine is ready
- **WHEN** provisioning is attempted
- **THEN** the command fails with the same actionable guidance the image pull produces

### Requirement: The store can be inspected and reclaimed

The CLI SHALL report what a store holds — its packages, the farms defined against it, and the disk each occupies. It SHALL provide a way to remove a farm, and a way to remove store content that no farm references. Reclamation SHALL never run implicitly as a side effect of another command.

#### Scenario: Inspection reports contents and size

- **GIVEN** a populated store
- **WHEN** the user inspects it
- **THEN** the output lists the packages, the farms, and the disk used

#### Scenario: Reclamation spares referenced content

- **GIVEN** a store whose content is referenced by at least one farm
- **WHEN** reclamation runs
- **THEN** referenced content is retained and only unreferenced content is removed

#### Scenario: Reclamation is never implicit

- **WHEN** any command other than the reclamation command runs
- **THEN** no store content is removed

### Requirement: A failed or interrupted provisioning run is recoverable

A provisioning run that fails or is interrupted SHALL leave the store in a state a later run can repair, and SHALL NOT leave the active farm pointing at an incomplete closure. The CLI SHALL report a concurrent-run conflict as an actionable message rather than an unhandled fault.

#### Scenario: An interrupted run is repaired by the next one

- **WHEN** provisioning is interrupted part-way
- **THEN** a subsequent run for the same farm completes it, and the store contains no partial package

#### Scenario: A concurrent run is reported clearly

- **GIVEN** a provisioning run already in progress against a store
- **WHEN** a second run starts against the same store
- **THEN** the second reports the conflict in a message that says what to do, and changes nothing
