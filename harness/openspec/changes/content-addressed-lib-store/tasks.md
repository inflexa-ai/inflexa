## 1. Provisioner image

- [ ] 1.1 Add `images/sandbox-provisioner/Dockerfile`, built `FROM` the same digest-pinned base image as `sandbox-base`, carrying `images/install-build-toolchain.sh` and the pinned `uv`
- [ ] 1.2 Assert in the build that the provisioner's base digest equals `sandbox-base`'s, so a drift fails the build rather than producing a mismatched ABI
- [ ] 1.3 Copy `images/sandbox-python/inflexa-libs-refresh` into the provisioner so the store and the images share one `packages.txt` generator
- [ ] 1.4 Add the provisioner to the image build workflow for both architectures

## 2. Store format and content addressing

- [ ] 2.1 Implement the tree hash over installed content: relative path, file bytes, executable bit, symlink target; exclude `__pycache__`, `.pyc`, `.nbi`, `.nbc`
- [ ] 2.2 Implement `store/<name>-<version>-<hash>/` publication: stage under `store/.staging/`, `chmod a+rX`, publish by rename within the store
- [ ] 2.3 Implement reuse — look up an existing directory for a resolved pin and confirm it against the recorded pin marker rather than trusting a name glob
- [ ] 2.4 Add a repair path that clears an abandoned `store/.staging/` entry left by an interrupted run
- [ ] 2.5 Add a `verify` operation that re-hashes store directories and reports any whose content no longer matches its address

## 3. Resolution and supply chain

- [ ] 3.1 Resolve the closure with `uv pip compile --generate-hashes` against an explicitly pinned index, and fail on an artifact served from an unexpected host
- [ ] 3.2 Install each pin with `--no-deps --target` into its staging directory, and verify the downloaded artifact against the recorded hash before installing
- [ ] 3.3 Write the lock file: requested specifications, resolved pins with source hashes, and the store directories that satisfy them
- [ ] 3.4 On re-provisioning an existing farm, resolve the union of previously requested and newly requested specifications

## 4. Farm assembly

- [ ] 4.1 Link per top-level entry into `farms/<analysis>/python/site-packages`, with targets under the store's in-container mount path, never a host path
- [ ] 4.2 Promote a colliding top-level name to a real directory and link both distributions beneath it; record every collision in the lock file
- [ ] 4.3 Hoist console scripts to a single directory the sandbox can put on `PATH`
- [ ] 4.4 Create `conda/` as an empty mount point, and do not create `r/` or `node/` subtrees for tracks this change does not provision, so the inventory does not advertise empty sections
- [ ] 4.5 Write `meta.json` and regenerate `packages.txt` via the shared generator, so `libStoreUsable` accepts the farm
- [ ] 4.6 Flip `current` to the farm before cache preparation, and make the provisioner the only writer of that pointer

## 5. Cache preparation and seeding

- [ ] 5.1 Prepare caches with `NUMBA_CACHE_DIR` and `MPLCONFIGDIR` under the farm, never in-tree
- [ ] 5.2 Run preparation with `PYTHONPATH` resolved through `/mnt/libs/current`, because the JIT cache key contains the source path
- [ ] 5.3 Accept a workload script rather than a module list, because compilation happens at first call and an import-only pass caches nothing
- [ ] 5.4 Record the prepared workload in the lock file so a verification run can replay exactly what was prepared
- [ ] 5.5 Seed the prepared caches into writable paths in `images/sandbox-base/sandbox-entrypoint.sh`, before the workload starts, in both the privileged and unprivileged entrypoint branches
- [ ] 5.6 Set `NUMBA_CPU_NAME` identically in the provisioner and the sandbox on arm64, or every prepared entry misses

## 6. R track

- [ ] 6.1 Reuse `images/gen-r-lock.R` to resolve and install the R track with pak, then content-address each package directory it produces (name and version read from each `DESCRIPTION`), like a Python distribution
- [ ] 6.2 Farm the R tracks into `r/cran`, `r/bioconductor`, and `r/github`, matching the three paths `libStoreEnv()` already sets in `R_LIBS_SITE`
- [ ] 6.3 Take the Bioconductor set from the pak bulk lock, which pak resolves and installs as one closure — no hand-ordering; the git pin (DEP) is one entry in that closure
- [ ] 6.4 Record the Bioconductor release and the R version with each stored R package, because Bioconductor couples the two
- [ ] 6.5 Keep `LinkingTo` packages consistent between compile time and run time, and record both in the lock file
- [ ] 6.6 Verify that a farmed R package loads: `library()` succeeds, and a package with compiled code executes

## 7. Concurrency and disk

- [ ] 7.1 Add a per-store lock so two provisioning runs cannot race on `current`
- [ ] 7.2 Refuse to re-point `current` while a sandbox has the store mounted, since replacing the symlink breaks a live container's view of the path
- [ ] 7.3 Expose reclamation and farm removal as harness operations only; the user-facing commands belong to the CLI change

## 8. Specs and agent-facing text

- [ ] 8.1 Apply the `lib-store` delta: the mount requirement gains the store-and-farm layout; "No runtime package installation" is removed and replaced
- [ ] 8.2 Apply the `lib-store-build` delta
- [ ] 8.3 Correct the `packages.txt` header, which currently states that no network and no build toolchain exist
- [ ] 8.4 Correct the `list_available_packages` tool description at `src/tools/sandbox/list-available-packages.ts:209` and `UNAVAILABLE_NOTE`
- [ ] 8.5 Correct `src/prompts/sandbox-standards.ts:94` to say the agent cannot install a package itself, rather than that the environment cannot change

## 9. Verification

- [ ] 9.1 Port `scripts/store-prototype/acceptance.py` into the repository's validation suite, keeping the checks for compiled extensions, `$ORIGIN`-relative vendored libraries, distribution metadata, and farm isolation
- [ ] 9.2 Add the cache-effectiveness check: replay the recorded workload with cache debugging on, and fail on any cache write at run time
- [ ] 9.3 Extend `scripts/lib-store-validate/validate.py` to run against a farm, so the "packages.txt must not lie" rule covers a store-backed mount
- [ ] 9.4 Add the store-against-image comparison: same manifest both ways, requiring versions and import results to agree
- [ ] 9.5 Add a test that an interrupted provisioning run leaves a store a later run can repair
- [ ] 9.6 Add a test that a tampered artifact hash fails the run and installs nothing
- [ ] 9.7 Add a test that the run fails with a clear message when the disk fills, and that it publishes no store directory. A publish is a rename out of `store/.staging/`, so a partial tree stays there, and task 9.5 covers it
- [ ] 9.8 Add a test that two concurrent provisioning runs against one store do not corrupt it, and that the second reports the conflict
- [ ] 9.9 Add a scale test at roughly 500 packages, recording farm build time, import time, and store size
- [ ] 9.10 Add a test that re-pointing `current` is refused while a sandbox has the store mounted
- [ ] 9.11 Run the whole suite on amd64; every measurement backing this change was taken on arm64
- [ ] 9.12 Re-measure import time on Linux and record it, since the macOS figure is dominated by virtiofs rather than by the design
