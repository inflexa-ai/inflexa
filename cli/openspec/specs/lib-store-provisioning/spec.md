# lib-store-provisioning Specification

## Purpose
TBD - created by archiving change add-lib-store-pull. Update Purpose after archive.
## Requirements
### Requirement: The setup flow provisions the store through the same pull handler

`inflexa setup` SHALL hand off to the same image-pull handler that
`inflexa sandbox pull` uses — it SHALL NOT implement a separate download path —
which prompts the variant, confirms the pull, and runs inside a `spinner()`.
Declining the pull SHALL skip the image step and continue setup, never abort it.
On a non-interactive terminal the setup flow SHALL NOT auto-pull; it SHALL print a
hint to run `inflexa sandbox pull <variant> --yes` and continue setup
successfully.

#### Scenario: Setup reuses the pull handler

- **WHEN** setup reaches the sandbox-image step interactively
- **THEN** provisioning calls the same handler as `inflexa sandbox pull`, which prompts the variant and runs inside a spinner

#### Scenario: Declining the pull skips the image

- **WHEN** the user declines the pull during `inflexa setup`
- **THEN** the image step is skipped and setup continues to completion rather than aborting

#### Scenario: Non-interactive setup does not auto-pull

- **WHEN** `inflexa setup` runs on a non-interactive terminal
- **THEN** no image is pulled; the CLI prints a hint to run `inflexa sandbox pull <variant> --yes` and setup continues

### Requirement: A missing store is offered, never fatal

The CLI SHALL, before launching a sandbox when the configured sandbox image is
not present, surface a one-line, actionable offer to run `inflexa sandbox pull`
and SHALL allow continuing. A missing image SHALL NOT silently dead-end: the offer
SHALL name the variant and the pull command, and when an image is genuinely
required to launch the CLI SHALL pull it (or prompt to) rather than failing out.

#### Scenario: Missing image surfaces an offer

- **GIVEN** the configured sandbox image is not present locally
- **WHEN** a sandbox is about to launch
- **THEN** the CLI prints an offer to run `inflexa sandbox pull` (naming the variant) before proceeding to obtain it

### Requirement: `inflexa sandbox pull` selects and pulls a sandbox image variant

The CLI SHALL provide `inflexa sandbox pull` (the command noun is `sandbox`, not
`libs`, because it fetches a sandbox image rather than a library store) that
resolves a **sandbox image variant**, `docker pull`s that image from GitHub
Packages (`ghcr.io/inflexa-ai/sandbox-<variant>`) using the active
container runtime, and records the pulled image reference as the sandbox image the
runtime launches (`harness.sandboxImage`). Pulling SHALL be idempotent: when the
resolved image is already present locally at the requested tag, the command SHALL
report "up to date" and pull nothing. The command SHALL accept a variant argument
(`python` | `python-r`) and a `--yes` flag for non-interactive use.

#### Scenario: A variant pull records the sandbox image

- **WHEN** `inflexa sandbox pull python-r` runs
- **THEN** the CLI pulls `ghcr.io/inflexa-ai/sandbox-python-r` and sets `harness.sandboxImage` to that reference

#### Scenario: Re-pull when present is a no-op

- **GIVEN** the resolved image is already present locally
- **WHEN** `inflexa sandbox pull` runs for the same variant
- **THEN** nothing is downloaded and the command reports the image is up to date

#### Scenario: A pull failure leaves the configured image unchanged

- **GIVEN** a `docker pull` that fails (network, auth, or unknown tag)
- **WHEN** `inflexa sandbox pull` runs
- **THEN** it fails with a clear error and `harness.sandboxImage` is left at its prior value

### Requirement: The user chooses the image variant; architecture is automatic

The CLI SHALL let the user choose the image variant — `python` (Python libraries
plus the bioconda CLI tools) or `python-r` (that plus the R libraries). The CLI
SHALL NOT ask for or force an architecture: the published images are multi-arch
manifests, so `docker pull` resolves the host architecture automatically. On a
host with no arm64 R image content, the CLI SHALL surface any variant
unavailability as an informational note rather than an error.

#### Scenario: The variant is chosen, the arch is not

- **WHEN** `inflexa sandbox pull` runs interactively
- **THEN** the user is prompted for `python` vs `python-r` and is never asked for an architecture

#### Scenario: Multi-arch pull resolves the host arch

- **GIVEN** the host is arm64
- **WHEN** the chosen variant image is pulled
- **THEN** docker resolves the arm64 image from the multi-arch manifest with no explicit platform flag

### Requirement: The pulled image is configured as the sandbox image

The CLI's `harness.sandboxImage` knob SHALL default to the GHCR-published tag and
SHALL be set to the pulled variant reference by `inflexa sandbox pull`. When a
sandbox launches, the harness-runtime composition SHALL create containers from
`harness.sandboxImage`; because the image bakes the library store at
`/mnt/libs/current` (with the resolver env and `packages.txt`), the CLI SHALL NOT
create any `/mnt/libs` bind mount and SHALL NOT force a container platform for the
local path.

#### Scenario: Sandboxes launch on the configured image

- **GIVEN** `harness.sandboxImage` set to a pulled `sandbox-python-r` reference
- **WHEN** a sandbox launches
- **THEN** the container is created from that image with no `/mnt/libs` bind mount and no forced platform

#### Scenario: Discovery reads the baked packages.txt

- **GIVEN** a sandbox launched on the pulled image with no mount
- **WHEN** `list_available_packages` runs
- **THEN** it reads the image's baked `/mnt/libs/current/packages.txt`

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

### Requirement: `inflexa sandbox status` reports the sandbox image

The CLI SHALL provide `inflexa sandbox status` (renamed from `inflexa libs
status`) reporting the configured sandbox image variant, its GHCR reference/tag,
whether the image is present locally, and the local image digest when present.
When no variant is configured or the image is absent, `status` SHALL say so
plainly and point at `inflexa sandbox pull`.

#### Scenario: Status with a pulled image

- **GIVEN** a configured, locally-present variant image
- **WHEN** `inflexa sandbox status` runs
- **THEN** it prints the variant, the GHCR reference, present state, and the local digest

#### Scenario: Status with no image

- **GIVEN** no configured or locally-present sandbox image
- **WHEN** `inflexa sandbox status` runs
- **THEN** it reports that no sandbox image is installed and points the user at `inflexa sandbox pull`

