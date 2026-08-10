# lib-store-provisioning Specification

## Purpose

This capability is the CLI surface that obtains the sandbox runtime image and wires
it to the harness. It gives `inflexa sandbox pull`, `inflexa sandbox status`, and
the pull handler that `inflexa setup` reuses.

The CLI pulls the one published runtime image from GHCR. The image is a multi-arch
manifest, thus the pull resolves the host architecture and the user selects no
variant. The CLI records the pulled reference as `harness.sandboxImage`. When the
configured image is absent, the CLI pulls it again from GHCR.

The runtime image bakes no R library and no Python library. Thus the CLI passes the
CLI-owned store root to the harness as `libStorePath` for every sandbox. The CLI
supplies the package inventory as the merge of the active farm and the baked image
fragment.

## Requirements

### Requirement: The setup flow provisions the store through the same pull handler

`inflexa setup` SHALL hand off to the same image-pull handler that
`inflexa sandbox pull` uses. It SHALL NOT do a separate download path. That
handler confirms the pull and runs inside a `spinner()`. Setup SHALL NOT ask which
image to pull, because one runtime image is published. Declining the pull SHALL skip the
image step and continue setup, never abort it. On a non-interactive terminal the
setup flow SHALL NOT auto-pull. It SHALL print a hint to run
`inflexa sandbox pull --yes` and continue setup successfully.

#### Scenario: Setup reuses the pull handler

- **WHEN** setup reaches the sandbox-image step interactively
- **THEN** provisioning calls the same handler as `inflexa sandbox pull`, which confirms the pull and runs inside a spinner

#### Scenario: Setup asks for no image choice

- **WHEN** setup reaches the sandbox-image step interactively
- **THEN** the user is asked whether to pull, and is never asked which image or which architecture

#### Scenario: Declining the pull skips the image

- **WHEN** the user declines the pull during `inflexa setup`
- **THEN** the image step is skipped and setup continues to completion rather than aborting

#### Scenario: Non-interactive setup does not auto-pull

- **WHEN** `inflexa setup` runs on a non-interactive terminal
- **THEN** no image is pulled; the CLI prints a hint to run `inflexa sandbox pull --yes` and setup continues

### Requirement: A missing store is offered, never fatal

The CLI SHALL, before launching a sandbox when the configured sandbox image is
not present, surface a one-line, actionable offer to run `inflexa sandbox pull`
and SHALL allow continuing. A missing image SHALL NOT silently dead-end: the offer
SHALL name the pull command. App launch SHALL NOT block on the image. When an
image is genuinely required, the hold happens at the first action that makes a
sandbox. The download gate (see `lib-store-download`) owns that hold, and it
reports its state while it holds.

#### Scenario: Missing image surfaces an offer

- **GIVEN** the configured sandbox image is not present locally
- **WHEN** a sandbox is about to launch
- **THEN** the CLI prints an offer to run `inflexa sandbox pull` before proceeding to obtain it

#### Scenario: App launch does not wait for the image

- **GIVEN** the configured sandbox image is not present locally
- **WHEN** the app opens
- **THEN** chat is usable at once, and the image wait happens at the first sandbox action

### Requirement: The pulled image is configured as the sandbox image

The CLI's `harness.sandboxImage` knob SHALL default to the GHCR-published tag of
the one runtime image. `inflexa sandbox pull` SHALL set it to that reference. When
a sandbox launches, the harness-runtime composition SHALL make containers from
`harness.sandboxImage`.

The runtime image bakes no R library and no Python library, so the CLI SHALL pass
the store root
to the harness as `libStorePath` for every sandbox. The harness then bind-mounts
that root read-only at `/mnt/libs`. The root SHALL be the fixed CLI-owned path,
never a value the configuration names, exactly as the reference store root is. The
pass SHALL be unconditional: there is no configuration value that suppresses it.

The CLI SHALL NOT re-do the usability check of the harness on that store. The
harness validates the store at each sandbox create, and it drops the mount when
the store is incomplete. A dropped mount is a failure the gate reports, not a fall
back to a baked library set, because no baked library set exists.

The CLI SHALL NOT force a container platform for the local path.

#### Scenario: Sandboxes launch on the configured image with the store

- **GIVEN** `harness.sandboxImage` set to the pulled runtime image reference
- **WHEN** a sandbox launches
- **THEN** the container is created from that image, the CLI passes the CLI-owned store root as `libStorePath`, and no platform is forced

#### Scenario: The store root passes with no switch

- **GIVEN** a configuration file with no store-related key
- **WHEN** a sandbox launches
- **THEN** the CLI passes the CLI-owned store root as `libStorePath`

#### Scenario: Discovery reads the mounted store inventory

- **GIVEN** a sandbox launched with the store mounted
- **WHEN** `list_available_packages` runs
- **THEN** it reads the active farm's `packages.txt` from the mounted store

#### Scenario: The CLI does not duplicate the store validity check

- **GIVEN** a store whose content is incomplete
- **WHEN** a sandbox launches
- **THEN** the CLI still passes the root, and the harness is what refuses the mount

### Requirement: `ensureSandboxImage` pulls the image from GHCR when missing

The pre-flight image check SHALL, when the configured `harness.sandboxImage` is
absent from the active runtime, obtain it by `docker pull` from GHCR (offering the
pull interactively, performing it directly with `--yes`/non-interactive) rather
than instructing the user to `docker build` it. A build-from-source hint MAY
remain as a fallback for a locally-tagged custom image.

#### Scenario: A missing configured image is pulled

- **GIVEN** `harness.sandboxImage` names a GHCR tag not present locally
- **WHEN** the pre-flight image check runs
- **THEN** the CLI pulls it from GHCR rather than failing with a `docker build` instruction

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

### Requirement: `inflexa sandbox status` reports the sandbox image

The CLI SHALL give `inflexa sandbox status` (renamed from `inflexa libs status`).
It reports the configured sandbox image, its GHCR reference/tag, the local presence
of the image, and the local image digest when present. It
SHALL also report the provisioner image the same way, because both images are
prerequisites of a working store. When an image is absent, `status` SHALL say so
plainly and point at the command that obtains it.

#### Scenario: Status with a pulled image

- **GIVEN** a configured, locally-present sandbox image
- **WHEN** `inflexa sandbox status` runs
- **THEN** it prints the GHCR reference, present state, and the local digest, for the sandbox image and for the provisioner image

#### Scenario: Status with no image

- **GIVEN** no configured or locally-present sandbox image
- **WHEN** `inflexa sandbox status` runs
- **THEN** it reports that no sandbox image is installed and points the user at `inflexa sandbox pull`

### Requirement: `inflexa sandbox pull` pulls the one sandbox image

The CLI SHALL give `inflexa sandbox pull`, which `docker pull`s the one published
runtime image (`ghcr.io/inflexa-ai/sandbox-base`) from GitHub Packages, through the
active container runtime. The command noun is `sandbox`, not `libs`, because it
fetches a sandbox image rather than a library store. It SHALL record the pulled
image reference as the sandbox image the runtime launches (`harness.sandboxImage`).
The command SHALL take no image argument, and SHALL NOT prompt for a choice. Pulling SHALL be
idempotent: when the resolved image is already present locally at the requested
tag, the command SHALL report "up to date" and pull nothing. The command SHALL
accept a `--yes` flag for non-interactive use.

#### Scenario: The pull records the sandbox image

- **WHEN** `inflexa sandbox pull` runs
- **THEN** the CLI pulls `ghcr.io/inflexa-ai/sandbox-base` and sets `harness.sandboxImage` to that reference

#### Scenario: An image argument is not accepted

- **WHEN** `inflexa sandbox pull python-r` runs
- **THEN** the command reports that it takes no image argument, and pulls nothing

#### Scenario: Re-pull when present is a no-op

- **GIVEN** the resolved image is already present locally
- **WHEN** `inflexa sandbox pull` runs
- **THEN** nothing is downloaded and the command reports the image is up to date

#### Scenario: A pull failure leaves the configured image unchanged

- **GIVEN** a `docker pull` that fails (network, auth, or unknown tag)
- **WHEN** `inflexa sandbox pull` runs
- **THEN** it fails with a clear error and `harness.sandboxImage` is left at its prior value

### Requirement: The architecture is automatic

The CLI SHALL NOT ask for or force an architecture: the published image is a
multi-arch manifest, so `docker pull` resolves the host architecture
automatically. The CLI SHALL surface any per-architecture gap in the published
package store as an informational note rather than an error.

#### Scenario: The arch is never asked

- **WHEN** `inflexa sandbox pull` runs interactively
- **THEN** the user is never asked for an architecture

#### Scenario: Multi-arch pull resolves the host arch

- **GIVEN** the host is arm64
- **WHEN** the image is pulled
- **THEN** docker resolves the arm64 image from the multi-arch manifest with no explicit platform flag

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
