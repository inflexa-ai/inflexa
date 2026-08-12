## ADDED Requirements

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

## MODIFIED Requirements

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
- **THEN** it reads the `packages.txt` the CLI supplies for the store

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

`list_available_packages` reads its inventory from the host paths the CLI supplies. The CLI SHALL supply the inventory as the merge of two sources: the store's pool, and the runtime image's baked fragment.

The store is the first source. It carries the two farm tracks, which are the Python
packages and the R packages. The CLI SHALL supply the pool inventory of the store,
because composition can link any pool package into an analysis farm on demand.

The runtime image is the second source. It bakes a fragment that lists the two
image-owned tracks, which are the bioconda command-line tools and the Node packages.
The fragment is not host-visible. The CLI SHALL extract the fragment one time for
each image and SHALL cache it on the host, keyed by the image digest. A pull of a
new image gives a new digest, thus the cache refreshes itself.

An absent fragment SHALL degrade to the store tracks alone. An extraction failure
gives no fragment, and the CLI SHALL supply none. The tool then reports the store
tracks alone. An absent fragment SHALL NOT fail the boot.

An inventory of the STORE that the CLI cannot read is a hard failure with a remedy,
not a silent degradation. The CLI SHALL report that the store is unusable, SHALL
name the remedy, and SHALL let the sandbox gate refuse the action. It SHALL NOT
start a sandbox that would carry no library.

#### Scenario: The store supplies the inventory

- **GIVEN** a store whose pool carries a package inventory
- **WHEN** a sandbox launches and `list_available_packages` runs
- **THEN** it reads the pool inventory

#### Scenario: An unreadable inventory refuses the action

- **GIVEN** a store whose inventory cannot be read
- **WHEN** a sandbox action runs
- **THEN** the CLI reports the store as unusable, names the remedy, and starts no sandbox

#### Scenario: The image fragment supplies the image-owned tracks

- **GIVEN** a store whose pool carries a package inventory, and a runtime image with the baked fragment
- **WHEN** a sandbox launches and `list_available_packages` runs
- **THEN** it reads the pool inventory merged with the image fragment, which the CLI extracted and cached by the image digest

#### Scenario: An absent fragment degrades to the store tracks alone

- **GIVEN** a runtime image whose fragment the CLI cannot extract
- **WHEN** a sandbox launches and `list_available_packages` runs
- **THEN** the CLI supplies no fragment, the boot continues, and the tool reports the store tracks alone

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

## REMOVED Requirements

### Requirement: The user chooses the image variant; architecture is automatic

**Reason**: The baked variants `sandbox-python` and `sandbox-python-r` retire, and
`sandbox-base` becomes the one runtime image. The variants existed to bake a
different package set into the image. The store now carries the package set, thus
a user chooses nothing.

**Migration**: The automatic-architecture half of this requirement moves to "The
architecture is automatic", which keeps both of its scenarios. Remove the variant
argument, the interactive variant prompt, and the variant table from the CLI. A
user who wants a different package set changes the store with
`inflexa store add`, not the image.

### Requirement: `inflexa sandbox pull` selects and pulls a sandbox image variant

**Reason**: One runtime image is published, so there is no variant to select. The
command name and its behavior stay, but the variant argument, the interactive
prompt, and the per-variant GHCR repository all go.

**Migration**: The replacement requirement is "`inflexa sandbox pull` pulls the one
sandbox image". It keeps the idempotent re-pull, the `--yes` flag, and the record
of `harness.sandboxImage`. Remove the variant argument from every call site and
from the documentation.
