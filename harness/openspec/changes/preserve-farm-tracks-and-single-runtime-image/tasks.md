## 1. Preserve the tracks of a farm

- [ ] 1.1 In `_provision` (`images/sandbox-provisioner/provision.py`), carry each track directory of the old farm forward into the staging farm, beside the `numba-cache` and `matplotlib_config` carry-forward at `:1015-1021`
- [ ] 1.2 Carry a track forward only when the run does not build that track, so a rebuilt track replaces the preserved one
- [ ] 1.3 Order the carry-forward before `build_farm`, so a run that adds a Python package writes into a staging farm that already holds the preserved trees
- [ ] 1.4 Report each preserved track and each rebuilt track in the run output, so a user reads what the published farm carries
- [ ] 1.5 Keep the atomic publish unchanged: the staging farm stays at a path that no consumer resolves, and `publish_farm` swaps it in one step

## 2. Record the tracks of the published farm

- [ ] 2.1 Compute the `meta.json` `tracks` list from the staging farm as published, not from the work of the run (`provision.py:1071-1080`)
- [ ] 2.2 Run the shared `packages.txt` producer after the carry-forward, so the inventory lists the packages of every preserved track
- [ ] 2.3 Record the preserved tracks in `lock.json`, so a later run knows which track it inherited and which it built
- [ ] 2.4 Keep the requested-specification union unchanged: a preserved track does not enter the Python request set
- [ ] 2.5 Remove the empty `conda` mount point that the farm assembly makes (`images/sandbox-provisioner/provision.py:357`), and its comment. Nothing mounts there after this change
- [ ] 2.6 Remove `conda` from the `rebuilt` list of the farm assembly (`provision.py:337`), because a farm holds no `conda` directory

## 3. Move the runtime env and the two image-owned tracks into the one image

- [ ] 3.1 Move `INFLEXA_LIB_ROOT`, `R_LIBS_SITE`, `NODE_PATH`, and the conda `PATH` from `images/sandbox-python/Dockerfile` into `images/sandbox-base/Dockerfile`
- [ ] 3.2 Move the empty mount points of `/mnt/libs/current` into `images/sandbox-base/Dockerfile`, so a bind of the store lands on a path that exists
- [ ] 3.3 Copy the `inflexa-libs-refresh` producer into `sandbox-base`, so the one image, the provisioner, and the store share one inventory producer
- [ ] 3.4 Keep the Python `.pth` at `images/sandbox-base/Dockerfile:239` unchanged
- [ ] 3.5 Move the conda-builder stage of `images/sandbox-python/Dockerfile` into `images/sandbox-base/Dockerfile`, and build the prefix at `/opt/conda`. Keep the bioconda tool set, the channel list, the strict channel priority, and the non-empty-tool floor
- [ ] 3.6 Build the prefix at `/opt/conda` directly. Do not build it elsewhere and then copy, link, or move it, because conda writes the absolute prefix path into each shebang and each RPATH
- [ ] 3.7 Move the node-builder stage of `images/sandbox-python/Dockerfile` into `images/sandbox-base/Dockerfile`, and install the Node packages at `/opt/node`. Keep the non-empty-package floor
- [ ] 3.8 Set the baked `PATH` to carry `/opt/conda/bin`, and set the baked `NODE_PATH` to `/opt/node/node_modules`. Neither names a path under `/mnt/libs`
- [ ] 3.9 In `src/sandbox/mount-plan.ts`, change the emitted `PATH` to carry `/opt/conda/bin`, and the emitted `NODE_PATH` to `/opt/node/node_modules` (`:118-122`)
- [ ] 3.10 Do a test of a plain container run of `sandbox-base`, with a store mounted and no harness. It must import a stored Python package, and load a stored R package
- [ ] 3.11 Do a test that a mounted store does not shadow the two image-owned tracks: a bioconda command-line tool resolves, and a baked Node package loads

## 4. Retire the baked variants

- [ ] 4.1 Delete `images/sandbox-python/` and `images/sandbox-python-r/`, after task 3 moves what `sandbox-base` needs
- [ ] 4.2 Reduce `.github/workflows/lib-store.yml` to one image build and one push (`:50-52`, `:137-176`). The workflow file is CI, not a spec
- [ ] 4.3 Point `.github/workflows/lib-store-acceptance.yml` at the published store artifact, mounted into `sandbox-base`, instead of a published variant image
- [ ] 4.4 Search the repository for a reference to `sandbox-python` or `sandbox-python-r` outside `cli/`, and correct each one
- [ ] 4.5 CI: build the one image for both architectures and publish it — the full build needs the self-hosted builders and about 1h35m

## 5. Specs

- [ ] 5.1 Apply the `lib-store-provisioner` delta: the added preservation requirement, and the modified record requirement
- [ ] 5.2 Apply the `lib-store-build` delta: the renamed and modified image requirement, the modified self-sufficiency requirement, the modified acceptance requirement, and the two removals
- [ ] 5.3 Apply the `lib-store` delta: the modified mount contract, and the modified resolver-env requirement that names `/opt/conda/bin` and `/opt/node/node_modules`
- [ ] 5.4 Correct the `Purpose` section of `openspec/specs/lib-store-build/spec.md`, which is still the archive placeholder

## 6. Verification

- [ ] 6.1 Do a test of `store add` of a Python package, against a farm with a `python` track and an `r` track. The published farm must still resolve each R package
- [ ] 6.2 Do a test that the published `meta.json` names both tracks after that run, and that `packages.txt` lists the R packages
- [ ] 6.3 Do a test that a run which builds the R track replaces the preserved R trees rather than merging them
- [ ] 6.4 Do a test that the preserved-track path installs nothing and opens no network connection
- [ ] 6.5 Do a test that a run stopped before the publish leaves a farm that still resolves both tracks
- [ ] 6.6 Do a test that `reclaim` spares each store directory that a preserved track references
- [ ] 6.7 Do a test that a farm which the provisioner builds holds no `conda` directory and no `node` directory
- [ ] 6.8 Do a test that a sandbox with a store mounted still resolves a bioconda command-line tool and a baked Node package
- [ ] 6.9 CI: do the full R track carry-forward test — the pak build does not fit the memory of a laptop

## 7. Open decisions

Task 7.1 to task 7.3 are one chain. Task 7.1 names the artifact that holds the
tracks after the retirement. Task 7.2 and task 7.3 both depend on that answer.
Answer them in the order 7.1, then 7.2, then 7.3. Task 7.4 is separate, and it
depends on none of them.

- [ ] 7.1 BLOCKED, ANSWER IT FIRST — which artifact feeds the per-track tarballs of the managed mount? The live requirement "Managed-mount tarballs are extracted from the published images" tars a subtree out of `sandbox-python`, which retires here. The options are: (a) extract the tracks from the content-addressed store, (b) keep a builder tree that no image publishes, or (c) retire the tarballs with Phase 5. Do not write a delta until the user decides

- [ ] 7.2 BLOCKED, ANSWER IT AFTER 7.1 — what does the build compare a store against? The live requirement "A store is validated against an equivalently built image" needs an image that bakes the same library set, and none remains. The artifact that task 7.1 selects is a candidate here. Options: (a) compare against the last published store, (b) compare against a throwaway builder tree, (c) retire the requirement and depend on acceptance. Do not write a delta until the user decides

- [ ] 7.3 BLOCKED, ANSWER IT AFTER 7.1 AND 7.2 — do the live requirements "The load check is best-effort with a non-empty-track floor" and "The build emits a per-arch coverage report and guards against regressions" move to the store build? Both name an image build that installs packages, thus the answer follows from the two answers above. Do not write a delta until the user decides

- [ ] 7.4 BLOCKED — how does `list_available_packages` advertise the two image-owned tracks? The inventory comes from the `packages.txt` of the active farm. The conda track and the Node track are no longer in a farm. The options are:
    - (a) the provisioner writes the two fragments into each farm that it builds
    - (b) the tool reads a second inventory file from the image
    - (c) the two tracks stay unadvertised

    Do not write a delta until the user decides
