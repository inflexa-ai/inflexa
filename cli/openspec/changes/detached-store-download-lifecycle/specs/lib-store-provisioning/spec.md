## ADDED Requirements

### Requirement: `inflexa sandbox remove` removes the two pulled images

The CLI SHALL give `inflexa sandbox remove`, beside `inflexa sandbox pull` and
`inflexa sandbox status`. The command removes the two pulled images, which are the
runtime image and the provisioner image.

The command SHALL report what it removed. It SHALL name each image that it
removed, and it SHALL name each image that was absent already.

An absent image SHALL NOT make the command refuse. Absence is a normal condition,
thus the command reports it and continues with the image that is on the machine.

The command SHALL NOT touch the store, and it SHALL NOT touch a farm. The two
images and the package catalog are separate artifacts. The `inflexa store` family
owns the catalog surface.

A later `inflexa sandbox pull` SHALL obtain the runtime image again. The removal
is complete, thus the transfer runs a second time.

The command SHALL take the `blocked` policy. The reason is that the removal
destroys a multi-gigabyte artifact that a user waited for. Thus the conversation
agent names the command, and the user runs it.

#### Scenario: The command removes the two images

- **GIVEN** a machine that holds the runtime image and the provisioner image
- **WHEN** `inflexa sandbox remove` runs
- **THEN** both images are gone, and the command names the two that it removed

#### Scenario: An absent image is reported, not refused

- **GIVEN** a machine that holds the runtime image only
- **WHEN** `inflexa sandbox remove` runs
- **THEN** the runtime image is gone, the command reports the absent provisioner image, and it does not fail

#### Scenario: The removal leaves the store as it is

- **GIVEN** a populated store with a farm
- **WHEN** `inflexa sandbox remove` runs
- **THEN** the store root and each farm are unchanged

#### Scenario: A pull after the removal obtains the image again

- **GIVEN** a machine on which `inflexa sandbox remove` ran
- **WHEN** `inflexa sandbox pull` runs
- **THEN** the CLI transfers the runtime image again

#### Scenario: The agent cannot run the removal

- **GIVEN** a user who asks the conversation agent to remove the images
- **WHEN** the agent reads the policy of the command
- **THEN** the CLI refuses the call, gives the reason, and names the command for the user

## MODIFIED Requirements

### Requirement: The package inventory describes what will actually be mounted

The CLI SHALL supply the inventory of the active farm of the store, which is the
one store a sandbox mounts. `list_available_packages` reads its inventory from a
host path that the CLI supplies.

The CLI SHALL NOT report an inventory from a source the sandbox will not mount.
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

#### Scenario: The store supplies the inventory

- **GIVEN** a store whose active farm carries a package inventory
- **WHEN** a sandbox launches and `list_available_packages` runs
- **THEN** it reads the inventory of that farm

#### Scenario: An unreadable inventory refuses the action

- **GIVEN** a store whose active farm inventory cannot be read
- **WHEN** a sandbox action runs
- **THEN** the CLI reports the store as unusable, names the remedy, and starts no sandbox

#### Scenario: An unreadable inventory does not fail the boot

- **GIVEN** a store whose active farm inventory cannot be read
- **WHEN** the app boots the harness runtime
- **THEN** the boot completes, the runtime reports ready, and the user can send a chat message

#### Scenario: The app answers on a machine with no store

- **GIVEN** a machine with no store on disk and a live download
- **WHEN** the user reads the workspace and asks the planner for a plan
- **THEN** both answer normally, and no sandbox starts

#### Scenario: A direct sandbox command keeps its own refusal

- **GIVEN** a store whose active farm inventory cannot be read
- **WHEN** `inflexa profile` or `inflexa run` runs
- **THEN** the command refuses, names the remedy, and starts no sandbox

#### Scenario: The image label cache is never the inventory

- **GIVEN** a store that the harness would refuse
- **WHEN** a sandbox action runs
- **THEN** the CLI reads no inventory from the image label cache
