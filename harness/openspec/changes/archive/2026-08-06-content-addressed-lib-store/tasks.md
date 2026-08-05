## 1. Provisioner image

- [x] 1.1 Add `images/sandbox-provisioner/Dockerfile`, built `FROM` the same digest-pinned base image as `sandbox-base`, carrying `images/install-build-toolchain.sh` and the pinned `uv`
- [x] 1.2 Assert in the build that the provisioner's base digest equals `sandbox-base`'s, so a drift fails the build rather than producing a mismatched ABI
- [x] 1.3 Copy `images/sandbox-python/inflexa-libs-refresh` into the provisioner so the store and the images share one `packages.txt` generator
- [x] 1.4 Add the provisioner to the image build workflow for both architectures

## 2. Store format and content addressing

- [x] 2.1 Implement the tree hash over installed content: relative path, file bytes, executable bit, symlink target; exclude `__pycache__`, `.pyc`, `.nbi`, `.nbc`
- [x] 2.2 Implement `store/<name>-<version>-<hash>/` publication: stage under `store/.staging/`, `chmod a+rX`, publish by rename within the store
- [x] 2.3 Implement reuse — look up an existing directory for a resolved pin and confirm it against the recorded pin marker rather than trusting a name glob
- [x] 2.4 Add a repair path that clears an abandoned `store/.staging/` entry left by an interrupted run
- [x] 2.5 Add a `verify` operation that re-hashes store directories and reports any whose content no longer matches its address

## 3. Resolution and supply chain

- [x] 3.1 Resolve the closure with `uv pip compile --generate-hashes` against an explicitly pinned index, and fail on an artifact served from an unexpected host
- [x] 3.2 Install each pin with `--no-deps --target` into its staging directory, and verify the downloaded artifact against the recorded hash before installing
- [x] 3.3 Write the lock file: requested specifications, resolved pins with source hashes, and the store directories that satisfy them
- [x] 3.4 On re-provisioning an existing farm, resolve the union of previously requested and newly requested specifications

## 4. Farm assembly

- [x] 4.1 Link per top-level entry into `farms/<analysis>/python/site-packages`, with targets under the store's in-container mount path, never a host path
- [x] 4.2 Promote a colliding top-level name to a real directory and link both distributions beneath it; record every collision in the lock file
- [x] 4.3 Hoist console scripts to a single directory the sandbox can put on `PATH`
- [x] 4.4 Create `conda/` as an empty mount point, and do not create a `node/` subtree, so the inventory does not advertise an empty section
- [x] 4.5 Write `meta.json` and regenerate `packages.txt` via the shared generator, so `libStoreUsable` accepts the farm
- [x] 4.6 Flip `current` to the farm before cache preparation, and make the provisioner the only writer of that pointer

## 5. Cache preparation and seeding

- [x] 5.1 Prepare caches with `NUMBA_CACHE_DIR` and `MPLCONFIGDIR` under the farm, never in-tree
- [x] 5.2 Run preparation with `PYTHONPATH` resolved through `/mnt/libs/current`, because the JIT cache key contains the source path
- [x] 5.3 Accept a workload script rather than a module list, because compilation happens at first call and an import-only pass caches nothing
- [x] 5.4 Record the prepared workload in the lock file so a verification run can replay exactly what was prepared
- [x] 5.5 Seed the prepared caches into writable paths in `images/sandbox-base/sandbox-entrypoint.sh`, before the workload starts, in both the privileged and unprivileged entrypoint branches
- [x] 5.6 Set `NUMBA_CPU_NAME` identically in the provisioner and the sandbox on arm64, or every prepared entry misses

## 6. R track

- [x] 6.1 Reuse `images/gen-r-lock.R` to resolve and install the R track with pak, then content-address each package directory it produces (name and version read from each `DESCRIPTION`), like a Python distribution
- [x] 6.2 Farm the R tracks into `r/cran`, `r/bioconductor`, and `r/github`, matching the three paths `libStoreEnv()` already sets in `R_LIBS_SITE`
- [x] 6.3 Take the Bioconductor set from the pak bulk lock, which pak resolves and installs as one closure — no hand-ordering; the git pin (DEP) is one entry in that closure
- [x] 6.4 Record the Bioconductor release and the R version with each stored R package, because Bioconductor couples the two
- [x] 6.5 Keep `LinkingTo` packages consistent between compile time and run time, and record both in the lock file
- [x] 6.6 Verify that a farmed R package loads: `library()` succeeds, and a package with compiled code executes

## 7. Concurrency and disk

- [x] 7.1 Add a per-store lock so two provisioning runs cannot race on `current`
- [x] 7.2 Refuse to re-point `current` while a sandbox has the store mounted, since replacing the symlink breaks a live container's view of the path
- [x] 7.3 Expose reclamation and farm removal as harness operations only; the user-facing commands belong to the CLI change

## 8. Specs and agent-facing text

- [x] 8.1 Apply the `lib-store` delta: the mount requirement gains the store-and-farm layout; "No runtime package installation" is removed and replaced
- [x] 8.2 Apply the `lib-store-build` delta
- [x] 8.3 Correct the `packages.txt` header, which currently states that no network and no build toolchain exist
- [x] 8.4 Correct the `list_available_packages` tool description at `src/tools/sandbox/list-available-packages.ts:209` and `UNAVAILABLE_NOTE`
- [x] 8.5 Correct `src/prompts/sandbox-standards.ts:94` to say the agent cannot install a package itself, rather than that the environment cannot change

## 9. Verification

- [x] 9.1 Port `scripts/store-prototype/acceptance.py` into `scripts/lib-store-provisioner-checks.sh`, or a sibling script beside it, keeping the checks for compiled extensions, `$ORIGIN`-relative vendored libraries, distribution metadata, and farm isolation
- [x] 9.2 Add the cache-effectiveness check: replay the recorded workload with cache debugging on, and fail on any cache write at run time
- [x] 9.3 Extend `scripts/lib-store-validate/validate.py` to run against a farm, so the "packages.txt must not lie" rule covers a store-backed mount
- [ ] 9.4 Add the store-against-image comparison: same manifest both ways, requiring versions and import results to agree — CI: needs the 11.4 GB baked image
- [x] 9.5 Add a test that an interrupted provisioning run leaves a store a later run can repair
- [x] 9.6 Add a test that a tampered artifact hash fails the run and installs nothing
- [x] 9.7 Add a test that the run fails with a clear message when the disk fills, and that it publishes no store directory. A publish is a rename out of `store/.staging/`, so a partial tree stays there, and task 9.5 covers it
- [x] 9.8 Add a test that two concurrent provisioning runs against one store do not corrupt it, and that the second reports the conflict
- [ ] 9.9 Add a scale test at roughly 500 packages, recording farm build time, import time, and store size — CI: the install does not fit this machine
- [x] 9.10 Add a test that re-pointing `current` is refused while a sandbox has the store mounted
- [ ] 9.11 Run the whole suite on amd64; every measurement backing this change was taken on arm64 — CI: needs an amd64 runner
- [ ] 9.12 Re-measure import time on Linux and record it, since the macOS figure is dominated by virtiofs rather than by the design — CI: needs a Linux bind mount

## 10. Publish

- [x] 10.1 Push the store to GHCR as an OCI artifact with ORAS, one artifact for each architecture, one layer for each track. Correct the workflow header, which still calls the publish deferred
- [x] 10.2 Refuse a same-version publish whose content differs, and fail the build loudly
- [x] 10.3 Add the dedicated store-build workflow: build the provisioner image, build the store with it, and push to GHCR. Decided 2026-08-05: a new workflow, and `lib-store.yml` does not change
