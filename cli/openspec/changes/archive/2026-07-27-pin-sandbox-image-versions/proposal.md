## Why

The CLI currently stores a moving `:latest` sandbox image reference, so an explicit refresh changes the execution environment without recording which published version was selected and leaves superseded multi-gigabyte image layers behind. Persisting the published version tag makes sandbox execution reproducible and gives cleanup an exact, CLI-owned predecessor to reclaim safely.

## What Changes

- Publish each sandbox image with machine-readable OCI version and revision metadata matching its existing `<date>-<sha>` release tag.
- Use `:latest` only as the discovery reference for an explicit `inflexa sandbox pull`.
- After pulling, resolve and validate the published version, create the equivalent local immutable tag, and persist that versioned reference as `harness.sandboxImage`.
- Treat a configured version tag as the execution identity: launch-time preflight restores that exact tag when missing and does not check for an update.
- After the new reference is validated and durably configured, best-effort remove superseded versions of the same Inflexa sandbox variant without force so unreferenced layers can be reclaimed.
- Preserve other variants, custom images, images still used by containers, and all unrelated Docker or Podman resources.
- Accept existing `:latest` configuration as a bootstrap/migration state and replace it on the next successful explicit or required first pull.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `lib-store-provisioning`: Change sandbox pulls from storing a moving channel reference to storing the resolved published version, define exact-version preflight behavior, and add bounded cleanup of superseded same-variant images.

## Impact

- CLI sandbox image selection, pull, status, config persistence, package-inventory lookup, and launch preflight under `src/modules/libs/` and `src/modules/harness/`.
- Sandbox image publication metadata in `.github/workflows/lib-store.yml` and the existing label-stamping script.
- Tests for pull state transitions, failure atomicity, cleanup safety, migration, and Docker/Podman-compatible command behavior.
- No new dependency, database migration, public command, command option, harness API, or agent-policy classification.
