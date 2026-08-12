# lib-store-provisioning Delta — Per-Analysis Farms

## MODIFIED Requirements

### Requirement: The package inventory describes what will actually be mounted

The CLI SHALL supply the pool inventory of the store for planning. The pool is the honest answer, because composition can link any pool package on demand. `list_available_packages` reads its inventory from a host path that the CLI supplies. Inside a sandbox, the truth stays the mounted farm, which composition made for that analysis.

The CLI SHALL NOT report an inventory from a source the store does not hold.
There is no second source. The runtime image bakes no library, thus the per-image
label cache describes an empty set. The CLI SHALL NOT fall back to it.

An inventory the CLI cannot read is a hard failure with a remedy, and it is not a
silent degradation. The CLI SHALL report that the store is unusable, SHALL name
the remedy, and SHALL let the sandbox gate refuse the action. It SHALL NOT start a
sandbox that would carry no library.

An unreadable store inventory SHALL NOT fail the harness boot. The boot SHALL
complete, and the runtime SHALL become ready. The sandbox gate already owns the
refusal, thus one refusal sits in one place. A boot failure would refuse a second
time, and it would take chat with it.

Chat, the workspace read surface, and the planner use no package. Each of the
three SHALL answer while the store is absent, while the inventory is unreadable,
and while the download runs.

A command that makes a sandbox at once SHALL keep its own refusal. `inflexa
profile` and `inflexa run` are the two such commands, and neither one passes
through the gate of the app.

#### Scenario: The pool supplies the planning inventory

- **GIVEN** a store whose pool holds a package that no farm links yet
- **WHEN** `list_available_packages` runs
- **THEN** the package is listed, because composition can link it on demand

#### Scenario: An unreadable inventory refuses the action

- **GIVEN** a store whose inventory cannot be read
- **WHEN** a sandbox action runs
- **THEN** the CLI reports the store as unusable, names the remedy, and starts no sandbox

#### Scenario: An unreadable inventory does not fail the boot

- **GIVEN** a store whose inventory cannot be read
- **WHEN** the app boots the harness runtime
- **THEN** the boot completes, the runtime reports ready, and the user can send a chat message

#### Scenario: The app answers on a machine with no store

- **GIVEN** a machine with no store on disk and a live download
- **WHEN** the user reads the workspace and asks the planner for a plan
- **THEN** both answer normally, and no sandbox starts

#### Scenario: A direct sandbox command keeps its own refusal

- **GIVEN** a store whose inventory cannot be read
- **WHEN** `inflexa profile` or `inflexa run` runs
- **THEN** the command refuses, names the remedy, and starts no sandbox

#### Scenario: The image label cache is never the inventory

- **GIVEN** a store that the harness would refuse
- **WHEN** a sandbox action runs
- **THEN** the CLI reads no inventory from the image label cache

## ADDED Requirements

### Requirement: The CLI wires the farm provider into the harness

The CLI SHALL supply the harness farm provider at its composition root. For an analysis id, the provider SHALL return `farms/<analysisId>` under the configured store root. When the farm is absent, the provider SHALL compose it first, then return it. When composition fails, the provider SHALL return no farm, and the sandbox gate SHALL name the failure state to the user.

The provider SHALL NOT return the template farm for an analysis, because the template belongs to composition, not to a sandbox.

#### Scenario: The provider returns the analysis farm

- **GIVEN** an analysis with a composed farm
- **WHEN** a sandbox of the analysis is created
- **THEN** the harness mounts `farms/<analysisId>` at `/mnt/libs/current`

#### Scenario: The provider composes on a miss

- **GIVEN** an analysis with no farm
- **WHEN** a sandbox action runs
- **THEN** the provider composes the farm, and the sandbox mounts it

#### Scenario: A composition failure surfaces in the gate

- **GIVEN** a composition that fails for a named reason
- **WHEN** the sandbox action runs
- **THEN** the gate reports the reason, and no sandbox starts

#### Scenario: The template is never mounted

- **WHEN** any sandbox is created
- **THEN** the mounted farm is an analysis farm, and never the catalog template
