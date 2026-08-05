## 1. Publish Version Identity

- [x] 1.1 Extend the existing sandbox metadata-stamping path to add validated `org.opencontainers.image.version` and `org.opencontainers.image.revision` labels to each selectable per-architecture image.
- [x] 1.2 Pass the workflow's single computed version and source revision into both Python and Python+R image stamping calls without changing the existing multi-arch tag set.
- [x] 1.3 Extend image publication or acceptance checks to fail when either selectable image lacks the expected version/revision metadata, and document the metadata contract in the image README.

## 2. Model Channel and Version References

- [x] 2.1 Add domain helpers in the libs module for the selected variant's `latest` channel reference, strict published-version parsing, and construction/parsing of versioned first-party references.
- [x] 2.2 Add unit tests covering valid versions, malformed or hostile label values, registry-port edge cases, channel references, versioned references, digests, and custom images.
- [x] 2.3 Define a runtime-command dependency seam for pull provisioning so Docker/Podman command sequences and failure results can be tested without a real daemon.

## 3. Implement the Transactional Pull

- [x] 3.1 Change `sandboxPull` to snapshot any prior moving alias, pull only the selected variant's `latest` channel, inspect and validate its version label, create the local version tag, and verify channel/version image-ID equality.
- [x] 3.2 Expand `PullError` and `PullOutcome` with typed metadata, tagging, verification, rollback, current-version, and cleanup-reporting states, consuming every `Result` through the established neverthrow conventions.
- [x] 3.3 Cache package inventory against the verified versioned image, then persist that exact reference while preserving the rest of the opaque harness config.
- [x] 3.4 Roll back a moved legacy `latest` alias and any uncommitted version alias when a post-pull step fails, without deleting the previously configured pinned reference.
- [x] 3.5 Add transition tests for first pin, same-version refresh, newer-version commit, each pre-commit failure stage, config-write failure, and legacy-alias restoration.

## 4. Reclaim Superseded Versions Safely

- [x] 4.1 Enumerate exact local tags only within the selected first-party variant repository and filter cleanup candidates through the strict published-version parser.
- [x] 4.2 After config commit, remove every superseded candidate by exact tag without force; classify removed and retained references without failing the successful pull.
- [x] 4.3 Report retained in-use versions concisely and avoid reclaimed-byte claims, daemon-wide prune commands, or changes to the existing approval-required command policy.
- [x] 4.4 Add tests proving cleanup retries older tagged versions, preserves the current version, `latest`, the other variant, non-version/custom/unrelated images and resources, and treats runtime removal conflicts as retained success.

## 5. Pin Launch Preflight

- [x] 5.1 Change the published-image provisioning seam to return the effective execution reference and thread that value through profile, run, and chat launch paths for the current invocation.
- [x] 5.2 Restore a missing configured published version by pulling that exact tag, with no `latest` substitution or cleanup.
- [x] 5.3 Route an absent bootstrap/legacy channel through version-resolving provisioning so it is persisted and used immediately, while allowing an already-present legacy channel to launch without a network update.
- [x] 5.4 Preserve the existing actionable behavior for missing custom images and add preflight tests for exact restoration, first-pull pinning, present-legacy behavior, and current-invocation pin use.

## 6. Status, Documentation, and Verification

- [x] 6.1 Update `sandbox status` to show the parsed pinned version or identify a legacy channel as unpinned while remaining registry-free and read-only.
- [x] 6.2 Update CLI documentation and the main `lib-store-provisioning` spec-facing language to describe explicit channel refresh, versioned execution, migration, and bounded cleanup.
- [x] 6.3 Run the focused libs, harness-preflight, CLI policy, and setup tests under both runtime descriptors, then run CLI typecheck and lint.
- [x] 6.4 Validate the OpenSpec change and verify no source dependency, database migration, public command/flag, harness API, or agent-policy snapshot changed outside the stated scope.
