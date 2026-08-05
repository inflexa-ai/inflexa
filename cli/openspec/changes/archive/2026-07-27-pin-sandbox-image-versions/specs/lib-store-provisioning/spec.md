## ADDED Requirements

### Requirement: Published sandbox images expose their immutable version identity

Each published selectable sandbox platform image SHALL carry `org.opencontainers.image.version` equal to the multi-arch image's published `<YYYYMMDD>-<7-hex-revision>` tag and `org.opencontainers.image.revision` equal to its source revision. The CLI SHALL accept a discovered version only when it matches `^[0-9]{8}-[0-9a-f]{7}$` and SHALL construct the pinned reference from the selected first-party repository rather than treating label content as a repository or command argument.

#### Scenario: Published image identifies its version

- **WHEN** the CLI pulls a selectable sandbox variant through its `latest` channel
- **THEN** the resolved platform image exposes the same version value as the published multi-arch version tag

#### Scenario: Invalid publication metadata cannot change config

- **WHEN** a pulled image has a missing or malformed version label
- **THEN** the pull operation fails without changing `harness.sandboxImage` or removing the previously configured image

### Requirement: Superseded sandbox versions are cleaned within a bounded ownership scope

After a versioned sandbox reference has been successfully written to config, the CLI SHALL enumerate only local tagged references in that selected Inflexa sandbox variant repository and SHALL attempt to remove every other tag matching the published-version grammar. When migrating a configured `latest` reference, the CLI SHALL additionally attempt to remove the exact prior image ID it captured before the channel moved. Removal SHALL use the exact tag or captured ID without force. Cleanup failure SHALL retain the affected image and SHALL NOT turn the successful pull and config transition into a failure. The CLI SHALL NOT remove `latest`, another sandbox variant, a custom image, a non-version tag, an image from another repository, a container, a volume, a network, or build cache, and SHALL NOT invoke daemon-wide image or system pruning.

#### Scenario: Superseded same-variant version is reclaimed

- **GIVEN** two unused published version tags exist locally for the selected variant
- **WHEN** the newer version is successfully configured
- **THEN** the CLI removes the older exact version tag and the runtime may reclaim layers no longer referenced elsewhere

#### Scenario: Version used by a container is retained

- **GIVEN** a superseded same-variant version is still referenced by a container
- **WHEN** post-pull cleanup attempts non-forced removal
- **THEN** the CLI retains and reports that version while the newly configured version remains successful

#### Scenario: First legacy refresh reclaims the former channel image

- **GIVEN** a configured `latest` reference points to an old image with no version tag
- **WHEN** a successful pull moves the channel and commits the new version
- **THEN** the CLI attempts non-forced removal of the exact prior image ID captured before the pull

#### Scenario: Other resources remain untouched

- **GIVEN** another sandbox variant, custom images, unrelated dangling images, containers, volumes, networks, or build cache exist
- **WHEN** post-pull cleanup runs
- **THEN** none of those resources are selected for removal

## MODIFIED Requirements

### Requirement: `inflexa sandbox pull` selects and pulls a sandbox image variant

The CLI SHALL provide `inflexa sandbox pull` (the command noun is `sandbox`, not `libs`, because it fetches a sandbox image rather than a library store) that resolves a **sandbox image variant**, pulls `ghcr.io/inflexa-ai/sandbox-<variant>:latest` using the active container runtime as the update-discovery channel, resolves the published version from the pulled platform image, creates and verifies the equivalent local `ghcr.io/inflexa-ai/sandbox-<variant>:<version>` tag, and records that versioned reference as the sandbox image the runtime launches (`harness.sandboxImage`). The command SHALL accept a variant argument (`python` | `python-r`) and a `--yes` flag for non-interactive use. Pulling the channel SHALL check for a newly published version even when `latest` is already present; when the resolved version equals the configured version, the command SHALL report the sandbox as up to date.

#### Scenario: A variant pull records the published version

- **WHEN** `inflexa sandbox pull python-r` resolves version `20260727-def5678` from `ghcr.io/inflexa-ai/sandbox-python-r:latest`
- **THEN** the CLI verifies a local `ghcr.io/inflexa-ai/sandbox-python-r:20260727-def5678` alias and sets `harness.sandboxImage` to that versioned reference

#### Scenario: Re-pull resolves the configured version

- **GIVEN** the channel and `harness.sandboxImage` both resolve to the same published version
- **WHEN** `inflexa sandbox pull` runs for that variant
- **THEN** the CLI reports the image is up to date and leaves the configured execution reference unchanged

#### Scenario: A pull failure leaves the configured image usable

- **GIVEN** a channel pull, version resolution, local tagging, verification, or config write fails
- **WHEN** `inflexa sandbox pull` runs
- **THEN** it fails with a clear typed error, leaves `harness.sandboxImage` at its prior value, and does not remove the prior configured image

#### Scenario: Legacy moving alias is restored after a failed transition

- **GIVEN** `harness.sandboxImage` is a locally present legacy `latest` reference
- **AND** pulling moves that local alias before a later transition step fails
- **WHEN** the operation rolls back
- **THEN** the CLI restores the local `latest` alias to its prior image ID so the unchanged config retains its prior local meaning

### Requirement: The pulled image is configured as the sandbox image

The CLI's unresolved bootstrap default MAY name the GHCR-published `latest` channel, but every successful provisioning pull SHALL set `harness.sandboxImage` to the resolved published version tag. When a sandbox launches, the harness-runtime composition SHALL create containers from that configured versioned reference; because the image bakes the library store at `/mnt/libs/current` (with the resolver env and `packages.txt`), the CLI SHALL NOT create any `/mnt/libs` bind mount and SHALL NOT force a container platform for the local path. The provisioning seam SHALL return the effective versioned execution reference so the invocation that first pins an image also launches that pin rather than its stale bootstrap reference.

#### Scenario: Sandboxes launch on the configured version

- **GIVEN** `harness.sandboxImage` is `ghcr.io/inflexa-ai/sandbox-python-r:20260727-def5678`
- **WHEN** a sandbox launches
- **THEN** the container is created from that exact reference with no `/mnt/libs` bind mount and no forced platform

#### Scenario: First provisioning uses its pin immediately

- **GIVEN** launch preflight begins from an absent bootstrap `latest` reference
- **WHEN** provisioning resolves and persists a published version
- **THEN** the current launch uses the returned versioned reference without requiring a second invocation

#### Scenario: Discovery reads the pinned image inventory

- **GIVEN** a sandbox launches on a pulled versioned image with no mount
- **WHEN** `list_available_packages` runs
- **THEN** it resolves the package inventory associated with that pinned local image ID

### Requirement: `ensureSandboxImage` pulls the image from GHCR when missing

The pre-flight image check SHALL, when a configured published version reference is absent from the active runtime, obtain that exact tag by pull from GHCR rather than substituting `latest`. When an absent bootstrap or legacy `latest` reference requires a pull, preflight SHALL use the version-resolving provisioning path, persist the resolved version tag, and return it for the current launch. An already-present legacy `latest` reference SHALL remain usable without an implicit network update and SHALL be migrated by the next explicit sandbox pull. A build-from-source hint MAY remain as a fallback for a locally tagged custom image.

#### Scenario: A missing configured version is restored exactly

- **GIVEN** `harness.sandboxImage` names a published version tag that is not present locally
- **WHEN** the pre-flight image check runs
- **THEN** the CLI pulls that exact version from GHCR and does not query or substitute `latest`

#### Scenario: Missing bootstrap channel becomes pinned

- **GIVEN** the bootstrap `latest` reference is absent locally
- **WHEN** preflight must provision an image
- **THEN** it pulls the channel, persists the resolved published version, and returns that versioned reference for the current launch

#### Scenario: Present legacy channel does not update on launch

- **GIVEN** an existing configuration names `latest` and that image is present locally
- **WHEN** launch preflight runs
- **THEN** it performs no network update and leaves migration to an explicit `inflexa sandbox pull`

### Requirement: `inflexa sandbox status` reports the sandbox image

The CLI SHALL provide `inflexa sandbox status` reporting the configured sandbox image variant, full reference, parsed published version when present, whether the image is present locally, and the local image digest when present. A configured `latest` reference SHALL be identified as an unpinned legacy/channel reference. When no image is present, status SHALL say so plainly and point the user at `inflexa sandbox pull`. Status SHALL remain passive: it SHALL NOT contact the registry, write config, create tags, or clean images.

#### Scenario: Status with a pinned image

- **GIVEN** a configured, locally present published version
- **WHEN** `inflexa sandbox status` runs
- **THEN** it prints the variant, full versioned reference, parsed version, present state, and local digest

#### Scenario: Status with a legacy channel

- **GIVEN** the configured image is a published `latest` reference
- **WHEN** `inflexa sandbox status` runs
- **THEN** it identifies the reference as unpinned without migrating it or contacting the registry

#### Scenario: Status with no local image

- **GIVEN** the configured image is absent locally
- **WHEN** `inflexa sandbox status` runs
- **THEN** it reports the image is not installed and points the user at `inflexa sandbox pull`
