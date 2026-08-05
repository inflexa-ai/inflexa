## ADDED Requirements

### Requirement: A local package store is optional and opt-in

The CLI SHALL support an optional configuration value naming a host package store root. It SHALL default to unset. When it is unset, the CLI SHALL behave exactly as it does without this capability: no store is passed to the harness, no `/mnt/libs` bind mount is requested, and the sandbox image's baked store is used.

The store root SHALL be distinct from the per-image package-inventory cache, which is a cache keyed by image identity and not a store.

#### Scenario: An existing installation is unaffected

- **GIVEN** no store is configured
- **WHEN** a sandbox launches
- **THEN** no store path is passed to the harness and the sandbox resolves imports from the image's baked store

#### Scenario: Opting in requires only configuration

- **GIVEN** a populated store on disk
- **WHEN** the user sets the store configuration value
- **THEN** subsequent sandboxes mount that store, with no other change required

#### Scenario: The store does not live in the inventory cache

- **WHEN** a store is created at its default location
- **THEN** its root is not the directory used to cache per-image package inventories

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
