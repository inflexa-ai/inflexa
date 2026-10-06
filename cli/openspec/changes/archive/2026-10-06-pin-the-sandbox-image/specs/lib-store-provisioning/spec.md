## MODIFIED Requirements

### Requirement: sandbox pull starts the two image transfers detached

`inflexa sandbox pull` MUST start the two image transfers as detached
transfer children and return at once, with a pointer at
`inflexa sandbox status`. No foreground image pull exists anywhere. A CLI
update that moves the pinned tag downloads the new pair through the same
transfers, thus the command is also the upgrade path. A transfer failure
MUST leave the configured image and the present image unchanged.

#### Scenario: The pull returns at once

- **WHEN** `inflexa sandbox pull` runs
- **THEN** the two transfer children start with their rows, and the command exits with the status pointer

#### Scenario: A failed transfer changes nothing

- **GIVEN** an image transfer that fails
- **WHEN** the child ends
- **THEN** the present image still serves, and `harness.sandboxImage` keeps its value

### Requirement: The pulled image is configured as the sandbox image

The `harness.sandboxImage` knob MUST default to a pinned build tag of the
runtime image. Its sandbox-server speaks the exec protocol of the harness
that the CLI pins. A moving tag MUST NOT be the default. No path pulls a
moving tag again, and an old sandbox-server refuses the requests of a newer
harness. The harness-runtime composition makes the containers from the
knob.

The image bakes no package. The CLI MUST pass the package-store root as
`libStorePath`, thus every sandbox receives the store and its farm as the
two read-only binds. Discovery reads the `inflexa.lock` of the mounted
farm. The provisioner reference DERIVES from `harness.sandboxImage`: the
same registry and tag, the name swapped. No provisioner config key exists,
thus the image pair cannot skew.

#### Scenario: Sandboxes launch with the store binds

- **GIVEN** a complete store and a farm
- **WHEN** a sandbox launches
- **THEN** the container comes from `harness.sandboxImage`, with the store at `/mnt/libs` and the farm at `/mnt/libs/farm`

#### Scenario: A CLI update asks for the image of its harness

- **GIVEN** a machine that holds the image of the earlier pin, and no `harness.sandboxImage` override
- **WHEN** the updated CLI starts a data profile
- **THEN** the sandbox gate refuses, and its message names `inflexa sandbox pull`
