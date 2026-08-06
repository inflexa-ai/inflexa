# Mount a host package store and let the user provision into it

## Why

The CLI has one way to change what a sandbox can import: pull a different image. `inflexa sandbox pull` fetches a multi-gigabyte image whose package set is fixed at build time, and `harness.sandboxImage` selects it. A user who needs one package that is not baked in has no path short of building their own image with a `FROM` stage, which the images README documents but which needs Docker knowledge and a build toolchain the published images deliberately omit.

The harness side of the alternative is the sibling change `content-addressed-lib-store`, which introduces a provisioner container and a content-addressed store on the host. This change is the embedder half. It is separate because specs are owned per subsystem, following the `add-tool-call-detail` and `render-tool-call-detail` precedent.

There is also a contradiction to settle. `harness/openspec/specs/lib-store/spec.md` describes the Docker backend bind-mounting a host directory named by `libStorePath`. `openspec/specs/lib-store-provisioning/spec.md:99` states that the CLI SHALL NOT create any `/mnt/libs` bind mount. The harness code supports the mount and the CLI never asks for it, so a live seam sits unused. This change uses it.

## What Changes

- **The CLI can pass `libStorePath`.** A configured store is bind-mounted read-only at `/mnt/libs` by the harness, which already validates it before every sandbox create. The setting defaults to unset, so nothing changes for an existing installation.
- **`packagesFile` follows the store.** `list_available_packages` reads its inventory from a host path. Today the CLI extracts it from an image label into a cache keyed by image ID. With a store configured, it comes from the store's active farm instead, so the inventory always describes what the sandbox will actually mount.
- **New commands to manage the store.** Add a package to an analysis's closure, list what a store holds, remove a farm, and reclaim store directories no farm references. Provisioning runs the network-enabled provisioner container; it is a state-changing action and takes the `approval` policy, matching `inflexa sandbox pull`.
- **The store and the baked image coexist.** With no store configured the image's baked store is used exactly as now. With one configured, the mount takes precedence. **BREAKING** for nothing: the default path is unchanged.
- **The container-runtime abstraction gains one caller.** Provisioning runs through the same `docker`/`podman` wrapper the image pull already uses, so engine selection and socket resolution are not duplicated.

Out of scope: the agent-facing install tool, which would let an agent request a package rather than a user. That needs the approval flow designed against the conversation agent and belongs in its own change. Also out of scope: the R, conda, and Node tracks. The cli surface starts with Python. The harness provisions R too, and the R surface joins in a later change. Also out of scope: the download of the CI-built store, which arrives from GHCR as an OCI artifact (decided 2026-08-05). That download, its receipt, and the gate that holds sandbox creation until the store is complete belong to their own change. This change consumes whatever store the configured root holds.

## Capabilities

### New Capabilities

- `package-store-management`: the host-side commands that create, inspect, extend, and reclaim a local package store, and the consent model for running a container that has network access.

### Modified Capabilities

- `lib-store-provisioning`: the CLI may now create a `/mnt/libs` bind mount when a store is configured, and the package inventory is read from the store rather than from the image label in that case.

## Impact

- `src/modules/harness/runtime.ts`: pass `libStorePath` into `createSandbox`; resolve `packagesFile` from the store when one is configured.
- `src/modules/harness/config.ts`: a new optional config key for the store root, defaulting to unset.
- `src/modules/libs/`: new provisioning and store-management module, beside the existing `pull.ts` and `packages.ts`.
- `src/cli/index.ts`: new commands, with the `approval` policy on anything that provisions and on anything that deletes.
- `src/lib/env.ts`: a store root distinct from `libsDir`, which is the image-inventory cache and whose own comment states it is not a library store.
- `openspec/specs/lib-store-provisioning/spec.md`: delta spec.
- Depends on `harness`'s `content-addressed-lib-store` for the provisioner image and the store format. Until a released harness carries it, CI for this subsystem fails on the unreleased dependency, which is the documented shape of a cross-subsystem change.
- The source of the provisioner image on a user machine is an open decision (`BLOCKED`). No workflow publishes that image today. Until the decision, the provisioning command takes an explicit image reference from the configuration, with no default.
