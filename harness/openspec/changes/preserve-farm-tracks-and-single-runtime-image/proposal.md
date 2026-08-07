## Why

A provisioning run destroys each track that the run does not rebuild.
`_provision` removes the staging farm and builds it fresh
(`images/sandbox-provisioner/provision.py:1005-1007`). It carries forward only
`numba-cache` and `matplotlib_config` (`:1015-1021`). It links the Python closure
that `build_farm` just resolved, and it rebuilds R only when the caller passes
`--r-manifest` (`:1026-1027`). Then `publish_farm` swaps the staging farm over the
live farm (`:393`), and `meta.json` records the tracks of that one run
(`:1071-1080`).

Two ordinary commands lose the R view. `store add scanpy` against a downloaded
catalog farm leaves a farm with a `python` track and an `r` track. `store add
anndata` then publishes a farm with the `python` track only. The R packages stay
in the content-addressed pool at `store/`, because nothing deletes them. Only the
links of the farm are gone, and the old `r/` directory of the farm is the record
of those links.

The second problem is new. The user decided to retire the baked variants
`sandbox-python` and `sandbox-python-r`. The variants exist to bake a different
package set into the image. The store now carries the package set, thus nothing is
left to vary.

`sandbox-base` becomes the only runtime image, and its `/mnt/libs/current` is
empty. As a result, the store is no longer an addition to a baked set. It becomes
the one source of a library. The roadmap open decision "replace or augment" (§8.1)
is now REPLACE.

The retirement removes the one source of two tracks that a farm cannot carry.
`sandbox-python` makes a conda prefix at `${INFLEXA_LIB_ROOT}/conda`, which is
`/mnt/libs/current/conda` (`images/sandbox-python/Dockerfile:261`), and the
sandbox puts that directory on `PATH` (`harness/src/sandbox/mount-plan.ts:120`).
The same image installs the Node packages at `${INFLEXA_LIB_ROOT}/node`
(`images/sandbox-python/Dockerfile:320`), and `NODE_PATH` names
`${INFLEXA_LIB_ROOT}/node/node_modules` (`:416`). The provisioner puts neither
track into a farm, thus the store cannot supply them.

As a result, `sandbox-base` carries more than the interpreters. It holds each
language interpreter, the system libraries, the conda prefix with the bioconda
tools, and the Node packages. Both tracks move to a path outside the store mount.
A store mounts
read-only over `/mnt/libs`, thus it shadows each path that the image bakes below
`/mnt/libs`.

The rule is short, and it has two halves. The image owns the language
interpreters, the system libraries, and each track that a farm cannot carry, which
is conda and Node. The store owns the packages of the two tracks that a farm can
carry, which are the Python packages and the R packages. A store never holds an
interpreter, thus no store changes the R version, the Python version, or the Node
version.

## What Changes

- **A provisioning run preserves each track that it does not rebuild.** The
  published farm carries every track that the target farm held before the run,
  together with the tracks that the run built. The run reinstalls nothing and it
  reaches no network for a preserved track.
- **`meta.json` and `packages.txt` describe the preserved tracks.** The inventory
  of a farm reports what a sandbox can import. A record of the current run alone
  makes the inventory lie about the preserved tracks.
- **BREAKING** — the build publishes one runtime image, not three.
  `sandbox-base` is the only runtime image. `sandbox-python` and
  `sandbox-python-r` retire.
- **BREAKING** — no runtime image bakes an R library or a Python library. A
  sandbox with no store mounted holds the conda tools and the Node packages of the
  image, and no library. The store is the one source of a library.
- **The one runtime image carries the conda track and the Node track.**
  `sandbox-base` builds the conda prefix at `/opt/conda`, with the bioconda tool
  set, the channel list, and the strict channel priority of the retired
  conda-builder stage. It installs the Node packages at `/opt/node`. Both paths
  are outside the store mount, thus a mounted store does not shadow them.
- **The build makes the conda prefix at its final path.** Conda writes the
  absolute prefix path into each shebang and each RPATH. Thus a prefix cannot move
  after the build, and it cannot be a link.
- **The one runtime image bakes the resolver env and the mount points.**
  `sandbox-python` bakes `R_LIBS_SITE`, `NODE_PATH`, the conda `PATH`, and
  `INFLEXA_LIB_ROOT` today. `sandbox-base` holds only the Python `.pth`
  (`images/sandbox-base/Dockerfile:239`). The env moves down to the one image, so
  a mounted store resolves with no harness.
- **The sandbox env names the two baked paths.** `mount-plan.ts` emits
  `/mnt/libs/current/conda/bin` on `PATH` and `/mnt/libs/current/node/node_modules`
  as `NODE_PATH` today. Both move to the baked paths, so the injected env does not
  remove the tools of the image.
- **A farm holds neither a `conda` directory nor a `node` directory.** The
  provisioner makes an empty `conda` directory as a mount point today
  (`images/sandbox-provisioner/provision.py:357`). Nothing mounts there after this
  change.
- **The downstream extension path through a `FROM` image retires.** A store mounts
  over `/mnt/libs`, thus it shadows anything that a downstream image installs at
  `/mnt/libs/current`. `inflexa store add` is the supported way to extend the
  package set.
- **The sandbox posture does not change.** No network, uid 1000, each capability
  dropped, and the store read-only.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `lib-store-provisioner`: a provisioning run preserves each track that it does
  not rebuild, and the records of the farm describe the preserved tracks.
- `lib-store-build`: the build publishes one runtime image, not three. The one
  image bakes the resolver env, the conda track, and the Node track, and it bakes
  no library. The requirement for a per-layer install path retires, and the
  downstream `FROM` extension path retires. Acceptance obtains the store from the
  published store artifact.
- `lib-store`: the store carries packages only, and it is the one source of a
  library. The image owns each interpreter, the conda track, and the Node track.
  The resolver env names the two baked paths, and a farm holds neither track.

## Requirements that this change removes

This change removes two published requirements. Both are in the `lib-store-build`
delta, with their reason and their migration note:

- `Every layer installs into the runtime mount path` — it describes the
  three-image ladder, and one runtime image remains that installs no library.
- `Downstream images extend the store through env-driven install locations` — a
  mounted store shadows each package that a downstream `FROM` image installs at
  `/mnt/libs/current`.

The `lib-store-build` delta also renames one requirement, from `The build
publishes three layered sandbox images` to `The build publishes one sandbox
runtime image`. A rename keeps the requirement, thus it is not a removal.

## Impact

- `images/sandbox-provisioner/provision.py`: `_provision` carries the tracks of
  the old farm forward beside the two cache directories, and the track record
  covers them. The empty `conda` mount point of the farm goes (`:357`).
- `images/sandbox-base/Dockerfile`: it gains the resolver env, the mount points,
  and the `packages.txt` producer that `images/sandbox-python/Dockerfile` holds
  today. It also gains the conda-builder stage and the node-builder stage, which
  write to `/opt/conda` and to `/opt/node`.
- `images/sandbox-python/` and `images/sandbox-python-r/`: both retire.
- `.github/workflows/lib-store.yml`: it builds and pushes the three images today
  (`:50-52`, `:137-176`). It builds one image after this change. The workflow file
  is CI, not a spec.
- `.github/workflows/lib-store-acceptance.yml`: acceptance boots a published
  variant image today. It obtains the store from the published store artifact
  after this change.
- `openspec/specs/lib-store-provisioner/spec.md`,
  `openspec/specs/lib-store-build/spec.md`, and `openspec/specs/lib-store/spec.md`:
  delta specs.
- `src/sandbox/mount-plan.ts`: the emitted `PATH` names `/opt/conda/bin`, and the
  emitted `NODE_PATH` names `/opt/node/node_modules`. The mount seam and the
  inventory tool are unchanged.
- The per-track tarballs of the managed mount read a subtree out of a published
  variant image today. The retirement removes that source, and the replacement
  source is an open decision. The tasks record it as `BLOCKED`.
- `cli/`: the embedder counterpart is a separate change, because each subsystem
  owns its specs. That change removes the variant surface, removes the store
  opt-in, and makes the provisioner image a constant.
