# Provision packages into a content-addressed store instead of baking them into the image

## Why

The sandbox image bakes every package it will ever offer. `sandbox-python` measures 11.4 GB and the R variant is larger. Three costs follow. A user cannot add a package, and the codebase states that impossibility in three places. Every analysis carries every package, including the ones it never imports. Changing the package set means an image rebuild and a multi-gigabyte pull.

The constraint that produced this shape is that the sandbox must have no network. That constraint is correct and does not change here. It was read, however, as *no container may have a network* — and that is a different, stronger claim than the security model needs.

A prototype under `scripts/store-prototype/` demonstrates the alternative and measures it. 15 of 15 acceptance checks pass on linux/arm64 against `sandbox-base` with a 50-distribution scanpy closure, including the cases most likely to break under relocation: compiled extensions, `$ORIGIN`-relative vendored shared libraries, distribution metadata, and namespace-package merging. Three analyses whose closures would occupy 1625 MB stored separately occupy 776 MB in one shared store, and a second scanpy analysis costs 8 MB.

The change also repairs a defect that exists today, independently of the store. `sandbox-python` ships 25 warmed numba cache entries and recompiles 24 of them at run time. numba selects a cache directory by writing a probe file to it, so a read-only store fails that probe and the in-tree cache is skipped for reads as well as writes. The warm-up in the image build has no runtime effect.

## What Changes

- **A provisioner container.** It holds a network and a compiler, and mounts the package store and nothing else, so it has no user data to leak to the network it can reach. It resolves a dependency closure, installs each distribution into its own directory, prepares caches, writes a lock file, and exits.
- **A content-addressed store.** `<root>/store/<name>-<version>-<hash>/` holds one distribution, write-once. The hash covers the installed file contents, so identical closures converge on one copy.
- **A symlink farm per analysis.** `<root>/farms/<analysis>/` holds links into the store, and `<root>/current` selects the active farm. The farm's interior is the layout the images already bake, so `.pth`, `R_LIBS_SITE`, and `NODE_PATH` keep their present meaning. Links target `/mnt/libs/store/…`, a path that resolves in the provisioner and in the sandbox alike.
- **Cache preparation moves to the provisioner**, which writes to `NUMBA_CACHE_DIR` under the farm rather than in-tree, and the sandbox entrypoint seeds it into a writable path before the workload starts. Two mechanical constraints are load-bearing and measured: the preparation must run through `/mnt/libs/current` because numba's cache key contains the source path, and it must *execute* code rather than import it, because numba compiles at first call.
- **The sandbox posture does not change.** No network, uid 1000, all capabilities dropped, store read-only. This change adds no code to any path that creates a sandbox.
- **BREAKING** — `lib-store` currently carries the requirement *"No runtime package installation"*. Installation becomes possible, mediated by the host. The sandbox still cannot reach a network, and the mount is still read-only; what changes is that a host action can add to the store between steps.

The Docker mount path needs no change. `libStorePath` already binds a host directory read-only at `/mnt/libs` (`src/sandbox/docker-client.ts:314`) and `libStoreUsable` already gates on `current/` resolving to a directory holding `packages.txt` and `meta.json` (`docker-client.ts:126`). The store and the farms live under that one existing bind.

- **R is provisioned alongside Python.** Measured, R is the easiest of the three languages to relocate: an installed R package contains no reference to its install path in any file, and its compiled objects carry no `RPATH`. A farm beats a long `R_LIBS_SITE` at the manifest's 168 R packages, so R uses the same farm design. The build work reuses `images/gen-r-lock.R`, which resolves the R track into a pak lockfile, installs it, and splits the result into per-package directories; because an R library holds one directory per package, that split tree is content-addressed like a Python distribution.

Out of scope, deferred to later changes: per-sandbox farms and the Kubernetes claim, which depend on a storage-class decision; the agent-facing install tool and its approval flow; conda and Node; making a package visible to a sandbox that is already running, which provisioning does not attempt. The manifest recipe schema is **retired**, not deferred: Phase 1 chose the pak lockfile as the recipe, so no schema is built.

## Capabilities

### New Capabilities

- `lib-store-provisioner`: the network-enabled provisioning container and the artifacts it produces — dependency resolution, content-addressed installation, farm assembly, cache preparation, and the lock file that records the closure.

### Modified Capabilities

- `lib-store`: the runtime mount contract gains the store-and-farm layout beneath `/mnt/libs`, and the requirement forbidding runtime package installation is replaced by one that permits host-mediated provisioning while keeping the sandbox without a network and the mount read-only.
- `lib-store-build`: the published artifact becomes a set of per-distribution content-addressed directories rather than per-track tarballs, and cache preparation becomes the provisioner's obligation rather than the image build's. The store publishes to GHCR as an OCI artifact, through an ORAS push (decided 2026-08-05). The track tarballs and their S3 publish stay only for the managed mount, until the managed delivery change replaces them.

## Impact

- `images/`: a new provisioner Dockerfile, built from the same digest-pinned base as `sandbox-base` so the compiled extensions match the runtime ABI. `sandbox-base/sandbox-entrypoint.sh` gains the cache-seeding step, which runs before the workload in every transport mode.
- `.github/workflows/`: a new, dedicated store-build workflow builds the provisioner image, builds the store with it, and pushes the artifact to GHCR, one for each architecture (decided 2026-08-05). `lib-store.yml` does not change.
- `openspec/specs/lib-store/spec.md` and `openspec/specs/lib-store-build/spec.md`: delta specs.
- `src/sandbox/`: no change. The seam already exists and is exercised by the prototype.
- Agent-facing copy in `src/tools/sandbox/list-available-packages.ts:209` and `src/prompts/sandbox-standards.ts:94` states that installation is impossible. Both become inaccurate and are corrected here, even though the tool that performs an install arrives in a later change.
- `cli/`: the embedder counterpart — passing `libStorePath`, pointing `packagesFile` at the farm, and the store commands — is a separate change, because specs are owned per subsystem.
- A contradiction between two existing specs is settled here. `openspec/specs/lib-store/spec.md` describes a `libStorePath` bind mount that `cli/openspec/specs/lib-store-provisioning/spec.md:99` forbids the CLI from creating.
