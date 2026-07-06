## Why

Companion to the harness change `add-layered-sandbox-images`, which makes the
analysis packages ship as three layered, publicly published images
(`sandbox-base` → `sandbox-python` → `sandbox-python-r` on
`ghcr.io/inflexa-ai/inf-cli`) with the libraries baked into `/mnt/libs/current`
and the resolver env baked in, so an image is self-sufficient with no mount.

That removes the CLI's whole reason to pull and assemble a per-track tarball
store on the user's machine. Today `inflexa libs pull` downloads six track
tarballs, verifies digests, assembles a versioned `~/.local/share/inflexa/libs`
directory with a `current` symlink, and the harness-runtime composition
bind-mounts it read-only at `/mnt/libs` and forces the sandbox container's arch
from the store's recorded metadata. That is a lot of moving parts for a first
run — and now it is redundant: the packages are in the image.

The new local-setup model is: **the user picks an image variant, the CLI
`docker pull`s it, and points sandboxes at it.** No local store directory, no
`/mnt/libs` bind mount, no client-side `packages.txt` assembly, no arch-forcing
(a multi-arch manifest resolves the host arch automatically). The per-track
tarballs still exist, but they are now **managed-only** — mounted by infra via
the Kubernetes PVC, never by this CLI.

## What Changes

- **`inflexa sandbox pull` (renamed from `inflexa libs pull`) selects and pulls an
  image, not tarballs.** The command noun moves from `libs` to `sandbox` because it
  now fetches a sandbox image rather than a library store. The user chooses a
  variant — `python` (Python libs + bioconda CLI tools) or `python-r` (adds R) —
  and the CLI `docker pull`s `ghcr.io/inflexa-ai/inf-cli/sandbox-<variant>` and
  records the chosen image as `harness.sandboxImage`. Re-running is a no-op when
  the image is present and current.

- **Sandboxes launch on the pulled image.** `harness.sandboxImage` becomes the
  configured variant tag rather than the hand-built `sandbox-base:latest`.
  `ensureSandboxImage` changes from "not found → tell the user to `docker build`"
  to "not found → `docker pull` it from GHCR (or offer to)".

- **No local store, no bind mount, no arch-forcing.** The versioned-directory +
  atomic-`current`-symlink store, the `libStorePath` bind mount, the
  `packages.txt` assembly, and the "force the sandbox platform from the store's
  recorded arch" logic are all removed from the local path. Discovery
  (`list_available_packages`) reads the baked `/mnt/libs/current/packages.txt`
  inside the image.

- **The tarball client is retired.** `src/modules/libs/{pull,store,manifest,arch}.ts`
  (per-track download, digest dedup, staging, assembly) is removed. The managed
  service continues to mount the extracted tarballs via its PVC — that path lives
  in infra/harness config (`libStorePvc`), not in this CLI.

- **`inflexa sandbox status` (renamed from `inflexa libs status`) reports the
  image, not a store.** It reports the configured variant, whether the image is
  present locally, and the tag/digest — and points at `inflexa sandbox pull` when
  absent.

- **Setup flow still reuses one handler.** `inflexa setup` hands off to the same
  image-pull handler (variant prompt + `docker pull`), keeping one dogfooded
  path; declining still skips and continues, non-interactive still prints a hint
  and continues.

## Capabilities

### Modified Capabilities

- `lib-store-provisioning`: reframed from "provision a mounted per-track store
  directory" to "select and pull a self-sufficient sandbox image and point the
  runtime at it." The tarball-pull/assembly/mount/arch-forcing requirements are
  removed; image-selection, image-pull, and `sandboxImage` configuration
  requirements replace them. The variant choice (previously forbidden — "the CLI
  SHALL NOT expose a bundle or stack choice") is reintroduced as an image-tier
  choice.

## Impact

- **`src/modules/libs/`**: `pull.ts` reworked to variant-select + `docker pull` +
  write `harness.sandboxImage`; `store.ts`, `manifest.ts`, `arch.ts` and their
  tests removed (managed mount no longer a CLI concern).
- **`src/modules/harness/config.ts`**: `DEFAULT_SANDBOX_IMAGE` points at the GHCR
  tag; `libStorePath`/`sandboxPlatform` resolution (`resolveLibStore`) removed for
  the local path.
- **`src/modules/harness/profile.ts`**: `ensureSandboxImage` `docker pull`s from
  GHCR instead of instructing a `docker build`; `offerLibStoreIfMissing` becomes
  an "offer to pull a sandbox image" prompt.
- **Depends on** the harness change `add-layered-sandbox-images` (the images and
  the GHCR publish must exist for the pull to resolve).
- **Docs**: setup docs present the image pull as the one-step local path.

## Out of Scope

- The managed mount path (Kubernetes PVC of the extracted tarballs) — owned by
  infra/harness config, unchanged here.
- The image build/publish and tarball extraction — the harness change.
