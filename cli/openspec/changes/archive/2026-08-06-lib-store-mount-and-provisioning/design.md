## Context

The CLI composes the harness at `src/modules/harness/runtime.ts`. It passes `refStorePath` but not `libStorePath`, because the sandbox image bakes its library store. The harness nevertheless supports the mount, and validates it per sandbox create.

Two host-side precedents already exist and should be followed rather than reinvented. `src/modules/refs/store.ts` is a full installer: installer-owned paths, atomic activation by rename, receipts written after the swap so a crash reads back as incomplete, per-file hash verification, and bounded concurrency. `src/modules/libs/pull.ts` is the consent model: a multi-gigabyte, state-changing, network-touching action gated behind the `approval` policy with an explicit size confirmation on first use.

`src/lib/container.ts` already abstracts Docker and Podman, including socket resolution and the per-runtime divergences. Provisioning is another container invocation and belongs behind it.

## Goals / Non-Goals

**Goals:**

- A user can add a package without building an image.
- The inventory an agent reads always describes what the sandbox will mount.
- An existing installation is unaffected until it opts in.
- One engine abstraction, one consent model, one installer pattern — all reused.

**Non-Goals:**

- An agent-facing install tool. A user drives provisioning here.
- Changing image pull. `inflexa sandbox pull` keeps working and stays the default path.
- The managed deployment, which mounts a volume claim rather than a host directory. It is decoupled: no decision here waits for it (2026-08-05).
- R, conda, and Node, matching the harness change's scope.

## Decisions

**Default the store to unset, and prefer the image when it is unset.** The alternative — migrating every installation to a store — would trade a working default for an unproven one and make rollback a data migration. With the key unset, `libStorePath` is not passed, no bind is created, and the behaviour is bit-for-bit what it is today. Opting in is setting one value; rolling back is clearing it.

**Let the harness decide whether the mount happens.** `libStoreUsable` already refuses a store whose `current` is missing, dangling, or incomplete, and drops the mount with a warning rather than failing the sandbox. The CLI should pass the path and not re-implement that check. Duplicating it would create two definitions of "usable" that drift, and the harness's runs at create time, which is the only moment that matters.

**Resolve `packagesFile` from the store when one is configured.** These are two sources for one fact, and the wrong one is worse than none: an agent told a package exists when the mount does not carry it will write code that fails at import. The rule is that the inventory comes from whatever will actually be mounted — the store's active farm when a store is configured, the image label cache otherwise.

**Keep the store root separate from `libsDir`.** `src/lib/env.ts` defines `libsDir` as the per-image inventory cache, and its comment states it is not a library store. It is keyed by image ID and pruned on that basis. Putting a real store inside it would mix content with cache. The prototype hit this and had to be relocated.

**Run provisioning through `src/lib/container.ts`.** Engine selection, readiness checks, and socket resolution are solved there and diverge between Docker and Podman in ways this change should not learn about again.

**Give provisioning the `approval` policy.** It starts a container with network access and writes to disk. `inflexa sandbox pull` sets the precedent for exactly this shape. Reclaiming disk deletes data and takes the same policy. Listing is read-only and stays `auto` — following `sandbox status`, which deliberately avoids writing config so a passive diagnostic stays passive.

**The provisioning command extends the active farm.** The store is per-installation, thus one farm is active. The harness resolves the union of the earlier requests and the new request, thus an add is additive by design. A named farm is an explicit option, not the default.

**The provisioner image comes from explicit configuration, with no default.** No workflow publishes the provisioner image for a user machine today, and the image source is an open decision (`BLOCKED`): a GHCR publish, or another route. The command requires a configured image reference, and it fails with clear guidance when the value is unset. Thus nothing guesses a registry path that does not exist.

**Adopt the reference-store installer's crash semantics.** Stage, rename, then record. A run killed between the rename and the record reads back as incomplete and the next run repairs it. This is proven in this codebase and needs no invention.

## Risks / Trade-offs

- **Two sources of truth for the inventory** → One rule, stated above and tested: the inventory follows the mount. A test asserts that a configured store's farm inventory is what `list_available_packages` reads, and that the image label is used only when no store is configured.
- **A user's store diverges from their image** → The store mounts over `/mnt/libs`, so the image's baked store is shadowed rather than merged. A store missing something the image had is a silent regression. Provisioning must therefore start from a closure that covers what the analysis needs, and the store-against-image comparison in the harness change is what proves that is possible.
- **CI is red for this subsystem until the harness releases** → Documented and expected for a cross-subsystem change. Sequencing the harness release and the version bump belongs to whoever drives the pull request.
- **Concurrent provisioning runs** → The harness change owns the store lock. The CLI must surface its failure as a clear message rather than a stack trace, because two terminals is a normal thing for a user to have.
- **A user reclaims disk that an archived analysis still needs** → Reclamation reports what it would remove before removing it, and never runs implicitly.
- **macOS import performance** → Measured at 2.73 s against 1.18 s for the same farm on the container filesystem; the cost is virtiofs on the bind mount, not the design. macOS is the primary local development platform, so this is felt exactly where the store is opt-in. It is a reason to keep the image path as the default until the number is re-measured on Linux.

## Migration Plan

1. Add the config key and the store-management commands. Nothing reads the key yet.
2. Pass `libStorePath` when the key is set. Unset installations are untouched.
3. Switch `packagesFile` to the store when the key is set.
4. Document opting in, and keep `inflexa sandbox pull` as the documented default.

Rollback is clearing the key. The image is unchanged throughout and remains a working fallback.

## Open Questions

All three are decided (2026-08-05):

- The store is per-installation, not per-analysis. The harness ships one `current` pointer. Per-analysis waits for the per-sandbox mount work.
- No image seeding. The GHCR download (the `lib-store-download` change) is the one delivery path for the CI-built store.
- An unusable store falls back to the image label cache, with a warning. The harness drops the mount, thus the sandbox runs the baked store, and the inventory follows the mount.
