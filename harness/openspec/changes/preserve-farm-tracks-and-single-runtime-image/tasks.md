## 1. Preserve the tracks of a farm

- [x] 1.1 In `_provision` (`images/sandbox-provisioner/provision.py`), carry each track directory of the old farm forward into the staging farm, beside the `numba-cache` and `matplotlib_config` carry-forward at `:1015-1021`
- [x] 1.2 Carry a track forward only when the run does not build that track, so a rebuilt track replaces the preserved one
- [x] 1.3 Order the carry-forward before `build_farm`, so a run that adds a Python package writes into a staging farm that already holds the preserved trees
- [x] 1.4 Report each preserved track and each rebuilt track in the run output, so a user reads what the published farm carries
- [x] 1.5 Keep the atomic publish unchanged: the staging farm stays at a path that no consumer resolves, and `publish_farm` swaps it in one step

## 2. Record the tracks of the published farm

- [x] 2.1 Compute the `meta.json` `tracks` list from the staging farm as published, not from the work of the run (`provision.py:1071-1080`)
- [x] 2.2 Run the shared `packages.txt` producer after the carry-forward, so the inventory lists the packages of every preserved track
- [x] 2.3 Record the preserved tracks in `lock.json`, so a later run knows which track it inherited and which it built
- [x] 2.4 Keep the requested-specification union unchanged: a preserved track does not enter the Python request set
- [x] 2.5 Remove the empty `conda` mount point that the farm assembly makes (`images/sandbox-provisioner/provision.py:357`), and its comment. Nothing mounts there after this change
- [x] 2.6 Remove `conda` from the `rebuilt` list of the farm assembly (`provision.py:337`), because a farm holds no `conda` directory. The `r`, `r-bulk.lock`, and R-fragment entries leave the list too, because `build_farm` would otherwise remove the track that the carry-forward just placed

## 3. Move the runtime env and the two image-owned tracks into the one image

- [x] 3.1 Move `INFLEXA_LIB_ROOT`, `R_LIBS_SITE`, `NODE_PATH`, and the conda `PATH` from `images/sandbox-python/Dockerfile` into `images/sandbox-base/Dockerfile`
- [x] 3.2 Move the empty mount points of `/mnt/libs/current` into `images/sandbox-base/Dockerfile`, so a bind of the store lands on a path that exists
- [x] 3.3 Copy the `inflexa-libs-refresh` producer into `sandbox-base`, so the one image, the provisioner, and the store share one inventory producer
- [x] 3.4 Keep the Python `.pth` at `images/sandbox-base/Dockerfile:239` unchanged
- [x] 3.5 Move the conda-builder stage of `images/sandbox-python/Dockerfile` into `images/sandbox-base/Dockerfile`, and build the prefix at `/opt/conda`. Keep the bioconda tool set, the channel list, the strict channel priority, and the non-empty-tool floor
- [x] 3.6 Build the prefix at `/opt/conda` directly. Do not build it elsewhere and then copy, link, or move it, because conda writes the absolute prefix path into each shebang and each RPATH
- [x] 3.7 Move the node-builder stage of `images/sandbox-python/Dockerfile` into `images/sandbox-base/Dockerfile`, and install the Node packages at `/opt/node`. Keep the non-empty-package floor
- [x] 3.8 Set the baked `PATH` to carry `/opt/conda/bin`, and set the baked `NODE_PATH` to `/opt/node/node_modules`. Neither names a path under `/mnt/libs`
- [x] 3.9 In `src/sandbox/mount-plan.ts`, change the emitted `PATH` to carry `/opt/conda/bin`, and the emitted `NODE_PATH` to `/opt/node/node_modules` (`:118-122`)
- [x] 3.10 Do a test of a plain container run of `sandbox-base`, with a store mounted and no harness. It must import a stored Python package, and load a stored R package. Done against a locally built arm64 image, with a minimal store of the published shape: a content-addressed pool, a farm of absolute links, and the two records. The store carries one Python distribution and one R package, thus the resolution path is real and the scale is not
- [x] 3.11 Do a test that a mounted store does not shadow the two image-owned tracks: a bioconda command-line tool resolves, and a baked Node package loads

## 4. Retire the baked variants

- [x] 4.1 Delete `images/sandbox-python/` and `images/sandbox-python-r/`, after task 3 moves what `sandbox-base` needs
- [x] 4.2 Reduce `.github/workflows/lib-store.yml` to one image build and one push (`:50-52`, `:137-176`). The workflow file is CI, not a spec
- [x] 4.3 Point `.github/workflows/lib-store-acceptance.yml` at the published store artifact, mounted into `sandbox-base`, instead of a published variant image
- [x] 4.4 Search the repository for a reference to `sandbox-python` or `sandbox-python-r` outside `cli/`, and correct each one. Corrected: `images/**`, `harness/src`, the two `lib-store*.yml` workflows, `.github/dependabot.yml`, `droast.toml`, `.github/workflows/lib-store-provisioner.yml`, and each script under `scripts/` that named the tarball source. The tarball scripts are deleted with decision 7.1. `scripts/store-prototype/**` stays as it is, because it is a record of a past measurement
- [x] 4.5 CI ONLY — build the one image for both architectures and publish it. Done: run 31393896753 published `sandbox-base` and `sandbox-provisioner` for both architectures, as multi-arch manifests

## 5. Specs

Task 5 waits on task 7.1 to task 7.4. Each one of those tasks decides a live
requirement. An apply writes the live spec, thus it must wait for the four
decisions.

- [x] 5.1 Apply the `lib-store-provisioner` delta: the added preservation requirement, and the modified record requirement
- [x] 5.2 Apply the `lib-store-build` delta: the renamed and modified image requirement, the modified self-sufficiency requirement, the modified acceptance requirement, and the two removals
- [x] 5.3 Apply the `lib-store` delta: the modified mount contract, and the modified resolver-env requirement that names `/opt/conda/bin` and `/opt/node/node_modules`
- [x] 5.4 Correct the `Purpose` section of `openspec/specs/lib-store-build/spec.md`, which is still the archive placeholder

## 6. Verification

Task 6.1 to task 6.7 are unit tests in `images/sandbox-provisioner/test_provision.py`.
Run them with `python3 -m unittest images/sandbox-provisioner/test_provision.py`.

- [x] 6.1 Do a test of `store add` of a Python package, against a farm with a `python` track and an `r` track. The published farm must still resolve each R package
- [x] 6.2 Do a test that the published `meta.json` names both tracks after that run, and that `packages.txt` lists the R packages
- [x] 6.3 Do a test that a run which builds the R track replaces the preserved R trees rather than merging them
- [x] 6.4 Do a test that the preserved-track path installs nothing and opens no network connection
- [x] 6.5 Do a test that a run stopped before the publish leaves a farm that still resolves both tracks
- [x] 6.6 Do a test that `reclaim` spares each store directory that a preserved track references
- [x] 6.7 Do a test that a farm which the provisioner builds holds no `conda` directory and no `node` directory
- [x] 6.8 Do a test that a sandbox with a store mounted still resolves a bioconda command-line tool and a baked Node package
- [ ] 6.9 CI ONLY — do the full R track carry-forward test. The pak build does not fit the memory of a laptop

## 7. Open decisions

Task 7.1 to task 7.3 are one chain. Task 7.1 names the artifact that holds the
tracks after the retirement. Task 7.2 and task 7.3 both depend on that answer.
Answer them in the order 7.1, then 7.2, then 7.3. Task 7.4 is separate, and it
depends on none of them.

- [x] 7.1 RESOLVED — the managed per-track tarballs retire (option c). The managed delivery is decoupled from OSS, and no runtime image carries a track to extract. The live requirement "Managed-mount tarballs are extracted from the published images" gets a REMOVED delta in `lib-store-build`, and the tarball extraction retires from the workflow and the scripts

- [x] 7.2 RESOLVED — the store-against-image compare retires (option c). No image bakes the same package set, thus there is no equivalently built image to compare a store against. The live requirement "A store is validated against an equivalently built image" gets a REMOVED delta, and acceptance is the validation

- [x] 7.3 RESOLVED — the load check and the coverage report move to the store build. The two live requirements "The load check is best-effort with a non-empty-track floor" and "The build emits a per-arch coverage report and guards against regressions" get MODIFIED deltas, and each now describes the store build, not an image build

- [x] 7.4 RESOLVED — the image advertises its two tracks with a baked inventory fragment (option b). The `sandbox-base` build writes the fragment at `/opt/inflexa/image-packages.txt`, outside `/mnt/libs`. The build derives the fragment from the conda and node load checks. `list_available_packages` merges the farm inventory and the image fragment, thus the agent reads one complete package list. The `lib-store` and `lib-store-build` deltas record it
