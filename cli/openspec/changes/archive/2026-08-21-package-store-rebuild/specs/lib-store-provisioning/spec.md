# Delta: lib-store-provisioning

No spec text of this change says "variant". The two images are two roles:
the runtime image (`sandbox-base`) runs the analyses, and the provisioner
image (`sandbox-provisioner`) installs the packages.

## ADDED Requirements

### Requirement: sandbox pull starts the two image transfers detached

`inflexa sandbox pull` MUST start the two image transfers as detached
transfer children and return at once, with a pointer at
`inflexa sandbox status`. No foreground image pull exists anywhere. A
moving tag refreshes through the same transfers, thus the command is the
upgrade path. A transfer failure MUST leave the configured image and the
present image unchanged.

#### Scenario: The pull returns at once

- **WHEN** `inflexa sandbox pull` runs
- **THEN** the two transfer children start with their rows, and the command exits with the status pointer

#### Scenario: A failed transfer changes nothing

- **GIVEN** an image transfer that fails
- **WHEN** the child ends
- **THEN** the present image still serves, and `harness.sandboxImage` keeps its value

### Requirement: The dev pre-flight refuses with the transfer hint

The pre-flight gate of a dev-channel command MUST refuse an absent image
with a hint that names `inflexa sandbox pull`. It MUST NOT start a
foreground pull, because the transfer lifecycle is the one download
mechanism.

#### Scenario: A missing image refuses with the hint

- **GIVEN** an absent runtime image
- **WHEN** `inflexa run` executes its pre-flight
- **THEN** the command refuses and names `inflexa sandbox pull`

### Requirement: sandbox remove removes the two images

The CLI MUST expose `inflexa sandbox remove`. It removes the runtime image
and the provisioner image, and it touches no store and no farm. Its agent
policy is `blocked`, because an agent must not delete multi-GB assets of
the user.

#### Scenario: Remove touches only the images

- **WHEN** `inflexa sandbox remove` runs
- **THEN** the two images leave the engine, and the store root is unchanged

## MODIFIED Requirements

### Requirement: The pulled image is configured as the sandbox image

The `harness.sandboxImage` knob MUST default to the GHCR tag of the runtime
image, and the harness-runtime composition creates containers from it. The
image bakes no package. The CLI MUST pass the package-store root as
`libStorePath`, thus every sandbox receives the store and its farm as the
two read-only binds. Discovery reads the `inflexa.lock` of the mounted
farm. The provisioner reference DERIVES from `harness.sandboxImage`: the
same registry and tag, the name swapped. No provisioner config key exists,
thus the image pair cannot skew.

#### Scenario: Sandboxes launch with the store binds

- **GIVEN** a complete store and a farm
- **WHEN** a sandbox launches
- **THEN** the container comes from `harness.sandboxImage`, with the store at `/mnt/libs` and the farm at `/mnt/libs/farm`

### Requirement: A missing store is offered, never fatal

A missing image and an incomplete store MUST surface an actionable offer
before a sandbox-making action, never a silent dead end. The offer names
the exact command: `inflexa sandbox pull` for the images, and
`inflexa store download` for the catalog.

#### Scenario: The offer names the command

- **GIVEN** a store with no receipt
- **WHEN** a sandbox-making action runs
- **THEN** the refusal names `inflexa store download`

### Requirement: `inflexa sandbox status` reports the sandbox image

`inflexa sandbox status` MUST report the two images — the reference, the
present state, and the local digest of each — the live transfer states, and
the store summary: the receipt state and the pool size. When an image is
absent, the status points at `inflexa sandbox pull`.

#### Scenario: Status with the two images present

- **WHEN** `inflexa sandbox status` runs with both images present
- **THEN** it prints each reference with its digest, and the store receipt state

## REMOVED Requirements

### Requirement: The setup flow provisions the store through the same pull handler

**Reason**: The detached transfer lifecycle replaces the foreground pull
handler in setup.
**Migration**: The `package-store-transfers` capability and the
`setup-answers` delta carry the setup flow.

### Requirement: The user chooses the image variant; architecture is automatic

**Reason**: One runtime image exists, thus no choice exists. The arch
resolution through the multi-arch manifest stays a fact of the pull.
**Migration**: None. The `--sandbox` answer becomes a bare flag.

### Requirement: `inflexa sandbox pull` selects and pulls a sandbox image variant

**Reason**: The command keeps its name and loses its shape: no argument,
and no foreground pull. The detached form is the added requirement
"sandbox pull starts the two image transfers detached".
**Migration**: Run `inflexa sandbox pull` with no argument.

### Requirement: `ensureSandboxImage` pulls the image from GHCR when missing

**Reason**: No foreground pull exists. The dev pre-flight refuses with the
hint, per the added requirement.
**Migration**: Run `inflexa sandbox pull`, then run the dev command again.
