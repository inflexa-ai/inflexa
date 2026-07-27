## Context

The selectable sandbox images are published under `ghcr.io/inflexa-ai/sandbox-{python,python-r}` with two multi-arch manifest tags: the moving `latest` channel and an immutable-by-policy `<YYYYMMDD>-<7-hex-revision>` version. The CLI currently pulls and persists `latest`. Consequently, config does not identify the installed environment, launch behavior depends on a mutable registry name, and each refresh can leave the former image and its unique multi-gigabyte layers behind.

Docker and Podman do not infer that a locally pulled `:latest` image also has a sibling version tag in the registry. They expose the content digest, but discovering an arbitrary sibling tag would require registry tag enumeration and matching. The publication pipeline must therefore carry the human-readable version with the selected platform image.

The change crosses the image publication workflow and the CLI's `libs` and harness-preflight modules. The public command and config field already exist; no harness-owned capability or new dependency is needed.

## Goals / Non-Goals

**Goals:**

- Persist a human-readable, versioned sandbox image reference after every successful published-image pull.
- Make `latest` an update-discovery channel only; sandbox execution uses the configured version tag.
- Preserve the previous executable configuration until the new image has been pulled, identified, locally tagged, verified, and durably configured.
- Reclaim superseded versions and their uniquely unreferenced layers within the exact selected Inflexa sandbox repository.
- Preserve safety across Docker and Podman by using common image commands, exact references, strict validation, and non-forced removal.
- Migrate existing moving references without requiring a config schema migration.

**Non-Goals:**

- Docker/Podman-wide image, container, volume, network, or build-cache pruning.
- Removing a different sandbox variant when the user changes variants.
- Managing custom images or third-party proxy/Postgres images.
- Providing rollback retention, a new cleanup command, an update check during passive status, or automatic network refresh on every launch.
- Changing the sandbox image contents, harness API, or agent command policy.

## Decisions

### Published platform images carry their version

The image publication workflow will stamp `org.opencontainers.image.version` with the existing `<date>-<sha>` value and `org.opencontainers.image.revision` with the source revision on each selectable per-architecture image before it is pushed. The existing label-only inventory rebuild is the natural stamping seam: it already ensures metadata is present on the platform image Docker or Podman inspects after resolving the multi-arch manifest.

The CLI will accept the version label only when it matches the publication grammar `^[0-9]{8}-[0-9a-f]{7}$`. It will construct the pinned reference from the known selected repository plus that validated value; registry-provided text is never accepted as a repository or arbitrary command argument.

Alternatives rejected:

- Persisting only `repo@sha256:<digest>` is immutable but loses the human-readable release identity requested by the config contract.
- Enumerating GHCR tags and matching digests adds registry API/authentication behavior when the image can carry its own identity.
- Inferring the version from creation time or revision alone can select a tag that was never published.

### Pull and execution references are separate concepts

For a selected variant, the pull source is always `ghcr.io/inflexa-ai/sandbox-<variant>:latest`; the execution reference written to `harness.sandboxImage` is `ghcr.io/inflexa-ai/sandbox-<variant>:<version>`.

After pulling the channel, the CLI reads and validates the version label, creates the local version tag from the pulled channel image, and verifies that the version tag resolves to the same local image ID. Creating the local tag avoids a redundant second registry pull. Because the identical version tag is also published remotely, launch preflight can restore it later with an exact pull if local storage is cleared.

The local `latest` tag may remain as the target used by future explicit pulls, but no successful provisioning flow writes it to config and runtime composition does not select it once a pin exists.

### Provisioning is an ordered commit

The published-image transition is:

1. Read the prior configured reference and, when it is a moving reference, retain its local image ID for possible rollback.
2. Pull the selected variant's `latest` channel.
3. Read and validate the published version label.
4. Create and verify the local version tag.
5. Resolve/cache the new image's package inventory as a non-fatal enrichment.
6. Write the versioned reference to config.
7. Best-effort clean superseded same-variant versions.

Pull, metadata, tag, verification, or config failures return a typed `PullError` and do not remove the prior pinned reference. If a legacy configured `latest` tag resolved locally before the attempt and the transition fails after the channel moved, the CLI restores that tag to its prior image ID so the unchanged config keeps its prior local meaning. A newly created version alias that was never committed may be removed best-effort.

Cleanup occurs only after the config commit, and cleanup failure does not turn a usable update into a failed pull. The outcome distinguishes a newly selected version from an already-current version and can carry retained-cleanup information for user-facing reporting.

### Cleanup is repository-scoped, version-aware, and non-forced

On a successful pull, the CLI enumerates local tagged references only within the exact selected Inflexa sandbox repository. It considers a reference removable only when its tag matches the strict published-version grammar and it is not the newly configured reference. It attempts removal by exact repository-and-version tag without `--force`.

This approach reclaims more than the immediately previous version, including an older candidate that was retained because a container used it during an earlier pull. A runtime conflict is an ordinary retained outcome: the tag and layers remain and a later explicit pull retries cleanup. Removing a tag lets the engine reclaim only layers no longer referenced by another tag, image, or container.

The migration from a configured `latest` reference is the one bounded exception to tag-based enumeration. The transaction already captured that alias's prior image ID for rollback; after a successful commit, if the channel moved, the CLI attempts to remove that exact old ID without force. This reclaims the newly dangling legacy image while still retaining it if a container or another tag references it.

The other variant, custom repositories, `latest`, digest references, non-version tags, and every unrelated image remain untouched. The CLI never invokes `image prune` or `system prune`.

Alternatives rejected:

- `image prune` and `system prune` operate across the user's daemon and can delete unrelated project state.
- Removing only the prior config reference cannot retry versions that were in use during an earlier transition.
- Forced removal weakens container safety and can erase aliases the engine still needs.
- Keeping one rollback version conflicts with the disk-reclamation goal and introduces retention policy not requested by the user.

### Launch preflight restores identity but does not discover updates

When `harness.sandboxImage` is a published version tag and is absent locally, preflight pulls that exact version. It never substitutes `latest`. Custom-image behavior remains unchanged.

An absent bootstrap/default `latest` reference is provisioned through the same version-resolving path and the returned pinned reference is used for the current launch as well as persisted for later launches. An already-present legacy `latest` reference is accepted without a network update; the next explicit `sandbox pull` migrates it. This avoids silently changing an installed environment merely because the CLI was upgraded.

The provisioning seam must return the effective execution reference so profile, run, and chat launch paths do not continue using the stale pre-resolution `latest` value during the first pinning invocation.

### Status reports configured identity without becoming an updater

`inflexa sandbox status` remains read-only. It reports the configured versioned reference and parsed version when available, identifies legacy `latest` as an unpinned channel reference, and performs no registry request, config migration, retagging, or cleanup.

## Risks / Trade-offs

- **[A published image lacks or misstates its version label]** → Reject the transition before config commit; validate both grammar and local image-ID equivalence.
- **[A legacy local `latest` alias moves before a later step fails]** → Snapshot its prior image ID and restore the alias on failure.
- **[A superseded image is still used by a container]** → Remove without force, retain it on conflict, report the retained version, and retry repository-scoped cleanup on a later explicit pull.
- **[Repository scanning removes a manually cached historical Inflexa version]** → Limit cleanup to the selected first-party repository and documented published-version grammar; accepting automatic current-version-only retention is the disk-reclamation trade-off.
- **[Version tags are mutable in the registry despite policy]** → The date-plus-source-revision naming convention and publication workflow are the authority. A future hardening change may persist tag-plus-digest, but digest pinning is not required for this human-readable config change.
- **[Docker and Podman output differ]** → Use structured `image inspect --format`, `image ls --format`, `tag`, and `image rm` commands already common to both supported runtimes, and test argument construction and result classification through an injected runtime-command seam.
- **[Cleanup reports misleading freed bytes because layers are shared]** → Report removed or retained version references, not estimated reclaimed bytes.

## Migration Plan

No config schema migration runs at startup. Existing custom references and pinned tags retain their meaning. Existing published `latest` references remain supported as a legacy/bootstrap state:

1. A successful explicit `inflexa sandbox pull` replaces them with the resolved version tag.
2. If the moving image is absent and launch preflight must pull it, that required pull also resolves, persists, and returns the version pin.
3. If the moving image is already present, launch proceeds without an implicit update; status identifies it as unpinned.

Rollback of the code remains compatible with the versioned string because the existing parser already accepts arbitrary sandbox image strings and version tags are ordinary pullable references. The older CLI will launch or restore the configured version rather than requiring `latest`.

## Open Questions

None. The selected retention policy is current version only within the selected managed variant, with non-forced retention while an image is in use.
