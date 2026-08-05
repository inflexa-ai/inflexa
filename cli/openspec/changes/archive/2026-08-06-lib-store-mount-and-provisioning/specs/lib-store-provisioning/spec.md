## MODIFIED Requirements

### Requirement: The pulled image is configured as the sandbox image

The CLI's `harness.sandboxImage` knob SHALL default to the GHCR-published tag and
SHALL be set to the pulled variant reference by `inflexa sandbox pull`. When a
sandbox launches, the harness-runtime composition SHALL create containers from
`harness.sandboxImage`.

When no host package store is configured, the image bakes the library store at
`/mnt/libs/current` (with the resolver env and `packages.txt`), and the CLI SHALL
NOT create any `/mnt/libs` bind mount and SHALL NOT force a container platform for
the local path.

When a host package store IS configured, the CLI SHALL pass its root to the
harness as `libStorePath`, so the harness bind-mounts it read-only at `/mnt/libs`.
The CLI SHALL NOT re-implement the harness's own usability check on that store;
the harness validates it at each sandbox create and drops the mount if it is
incomplete.

#### Scenario: Sandboxes launch on the configured image

- **GIVEN** `harness.sandboxImage` set to a pulled `sandbox-python-r` reference and no store configured
- **WHEN** a sandbox launches
- **THEN** the container is created from that image with no `/mnt/libs` bind mount and no forced platform

#### Scenario: Discovery reads the baked packages.txt

- **GIVEN** a sandbox launched on the pulled image with no mount
- **WHEN** `list_available_packages` runs
- **THEN** it reads the image's baked `/mnt/libs/current/packages.txt`

#### Scenario: A configured store is mounted over the baked one

- **GIVEN** a configured, usable host package store
- **WHEN** a sandbox launches
- **THEN** the CLI passes the store root as `libStorePath` and the sandbox resolves imports from the mounted store

#### Scenario: The CLI does not duplicate the store validity check

- **GIVEN** a configured store that is incomplete
- **WHEN** a sandbox launches
- **THEN** the CLI still passes the path, and the harness is what refuses the mount

## ADDED Requirements

### Requirement: The package inventory describes what will actually be mounted

`list_available_packages` reads its inventory from a host path supplied by the CLI. The CLI SHALL supply the inventory belonging to whichever store the sandbox will mount: the active farm's inventory when a host store is configured, and the image label cache otherwise.

The CLI SHALL NOT report an inventory from a source the sandbox will not mount.

#### Scenario: A configured store supplies the inventory

- **GIVEN** a configured store whose active farm carries a package inventory
- **WHEN** a sandbox launches and `list_available_packages` runs
- **THEN** it reads the farm's inventory, not the image label cache

#### Scenario: No store falls back to the image label

- **GIVEN** no configured store
- **WHEN** `list_available_packages` runs
- **THEN** it reads the inventory extracted from the image label, as today

#### Scenario: An unreadable inventory is not fatal

- **GIVEN** a configured store whose inventory cannot be read
- **WHEN** `list_available_packages` runs
- **THEN** it reports the inventory as unavailable rather than failing the step
