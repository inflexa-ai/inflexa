## Context

The provisioner assembles each farm in a staging path, then it swaps the staging
path over the live farm in one step (`provision.py:393`). The swap is correct, and
this change does not touch it. The defect is upstream of the swap: the staging
farm holds only what the run itself built.

`_provision` makes the staging farm empty (`:1005-1007`). It moves two cache
directories across (`:1015-1021`), it links the Python closure of the run, and it
builds R only under `--r-manifest` (`:1026-1027`). The CLI never passes
`--r-manifest` (`cli/src/modules/libs/store.ts:211`). Thus a second `store add`
against a farm with an `r` track publishes a farm with a `python` track only.

The packages themselves survive. The content-addressed pool at `store/` is
write-once, and only `reclaim` removes a directory from it. What the run destroys
is the view of the farm: the `r/cran`, `r/bioconductor`, and `r/github` link
trees. Those trees are the record of the links, thus they restore the invariant
with no reinstall and no network.

Separately, the user decided to retire `sandbox-python` and `sandbox-python-r`.
`sandbox-base` becomes the only runtime image. Its `/mnt/libs/current` is empty,
thus a sandbox with no store has no library.

That retirement also removes the one source of two tracks that a farm cannot
carry. `sandbox-python` builds a conda prefix at `/mnt/libs/current/conda`
(`images/sandbox-python/Dockerfile:261`), and it installs the Node packages at
`/mnt/libs/current/node` (`:320`). The provisioner has no conda code and no npm
code, thus a farm holds neither track.

## Goals / Non-Goals

**Goals:**

- A provisioning run never removes a track that the run does not rebuild.
- The records of a farm describe every track that the published farm carries.
- One runtime image, with no baked library.
- The one runtime image carries each track that a farm cannot carry.
- The one runtime image resolves a mounted store with no harness.
- No change to the sandbox posture, and no change to the mount seam.

**Non-Goals:**

- A merge of two farms. The provisioner extends one farm. It never joins two.
- The CLI surface. The store commands, the download gate, and the provisioner
  image constant belong to the CLI change.
- The delivery of the store to a machine. That path is built and archived.
- The managed service and the Kubernetes claim. Both stay decoupled.

## Decisions

**Carry the track directories of the old farm forward, beside the two caches.**
The old farm already holds the link trees of each track. A move of a directory is
atomic, and it reads no file content. Thus the carry-forward costs no reinstall
and no network.

The alternative is to pass `--r-manifest` on every run, which makes a full pak
build. That build takes about 1h35m and it needs a network. Thus a `store add` of
one Python package would pay for the whole R track.

A second alternative is to build the staging farm as a copy of the live farm. A
copy of the symlink farm is slow, and it reads the live farm while the run can
still fail. The move of a directory keeps the live farm complete until the swap,
which is the property that the atomic publish depends on.

**Derive the track record from the published farm, not from the run.**
`meta.json` lists the tracks of the current run today (`:1071-1080`), and
`packages.txt` comes from the staging farm through the shared producer. Both must
run after the carry-forward. A record of the run alone reports a `python` track
for a farm that also carries `r`. Thus `list_available_packages` would deny a
package that the sandbox can import.

**Keep the rebuild rule simple: a run replaces a track that it builds.** A run
that builds the R track replaces the preserved R trees. A run that builds no R
track keeps them. Thus the rule is one sentence, and a track is never half of two
runs.

**One runtime image. [decided by the user]** The variants exist to bake a
different package set. The store now carries the package set, thus the variant
axis has no content.

The rejected alternative is to keep `sandbox-python` and `sandbox-python-r` as a
fallback. Three costs decide against it. The image stays at 11.4 GB, and the user
pays for it beside the store. The package set has two sources that drift, and a
mounted store shadows the baked one silently. And each build, each acceptance run,
and each spec carries three images for one runtime.

**The image owns each track that a farm cannot carry. [decided by the user]** The
image owns the language interpreters, the system libraries, the conda track, and
the Node track. The store owns the packages of the two tracks that a farm can
carry, which are the Python packages and the R packages. Thus `sandbox-base`
builds the conda prefix with the bioconda tools, and it installs the Node
packages, both at a path outside the store mount.

The second half of the boundary is the language itself. `sandbox-base` carries
each interpreter. R comes from the digest-pinned base image
`rocker/r-ver:4.6.0@sha256:6f05a1a8…` (`images/sandbox-base/Dockerfile:14`), which
`images/lib-store-manifest.yaml:8` mirrors as `base_image`. Python 3.12 and
`libpython3.12` come from apt in the same image (`:57-58`), and Node.js comes from
apt too (`:113`).

The store holds packages only. It never holds an interpreter, thus no store
changes the R version, the Python version, or the Node version.

The dependency runs from the image to the store, and never the other way. Each
stored R package records the R version and the Bioconductor release that it
compiled against. The provisioner image is built FROM the same digest-pinned base
as `sandbox-base`, and the build asserts that the two digests are equal. Thus each
compiled extension matches the ABI of the runtime. A bump of the base image
obliges a rebuild of the compiled packages of the store, and a store change never
obliges an image change.

A store mounts read-only over `/mnt/libs`. Thus it shadows each path that the
image bakes below `/mnt/libs`, and the current paths `/mnt/libs/current/conda` and
`/mnt/libs/current/node` disappear the moment that a store mounts. The two tracks
move to `/opt/conda` and to `/opt/node`.

The conda prefix must be BUILT at its final path. Conda writes the absolute prefix
path into each shebang and each RPATH. Thus a copy, a link, or a move gives a
prefix that does not run. This is also the reason that a farm never holds conda.

The rejected alternative for conda is a second bind mount that carries a conda
prefix from the store. A staged farm swaps its path at publish time, thus a prefix
in a farm would be built at one path and read at another. The prefix would not
run.

The rejected alternative for Node is to teach the provisioner to build a Node
farm. npm hoists a flat `node_modules` tree, which does not divide into one
directory for each package. A Python distribution and an R package do divide that
way, thus the link-tree code has no counterpart here. The manifest holds one Node
package, thus the cost is real and the value is near zero.

**Move the resolver env down into the one image.** `sandbox-python` bakes
`R_LIBS_SITE`, `NODE_PATH`, the conda `PATH`, `INFLEXA_LIB_ROOT`, and the
`packages.txt` producer. `sandbox-base` holds only the Python `.pth`
(`images/sandbox-base/Dockerfile:239`). The harness injects the same env when it
mounts the store, thus the harness path works either way. The bake keeps the
promise that a plain container run against a mounted store resolves an import.

The conda `PATH` and `NODE_PATH` name the two baked paths in both places.
`mount-plan.ts` emits store-relative values today. The harness injects `PATH` and
`NODE_PATH` in full when it mounts the store. Thus a store-relative value would
remove the tools of the image from each sandbox that has a store.

**Retire the downstream `FROM` extension path.** A store mounts read-only over
`/mnt/libs`, thus it shadows each package that a downstream image installs at
`/mnt/libs/current`. The store is mandatory after this change, thus the shadow is
not an edge case. `inflexa store add` is the supported way to extend the package
set, and it writes into the store that the sandbox mounts.

**Acceptance obtains the store from the published store artifact.** Acceptance
boots a published variant image today, which is the OSS user path. That path
carries no package after this change. The store artifact is what a user pulls,
thus it is the honest source for the import-all invariant and the smoke-test
suite.

## Risks / Trade-offs

- **A preserved track goes stale against a new runtime** → each stored R package
  records the R version and the Bioconductor release. A run that rebuilds the
  track replaces the preserved trees. A user who wants a rebuild names the track.
- **A preserved link points at a reclaimed store directory** → `reclaim` spares
  each store directory that a farm references (`provision.py:_referenced_store_dirs`).
  The preserved trees live in the live farm, thus the scan already covers them.
- **The carry-forward hides a track that the user wanted gone** → farm removal
  and a fresh farm name stay the way to drop a track. An add never removes.
- **A sandbox with no store has no library** → the store is mandatory after this
  change. The CLI change gates each action that makes a sandbox, and it reports
  an unusable store as a failure with a remedy.
- **The one image is no longer minimal** → it carries the conda prefix and the
  Node packages, thus it is larger than a runtime-only image. A farm cannot carry
  the two tracks, thus there is no smaller correct place for them.
- **An old farm still holds an empty `conda` directory** → the directory is inert.
  Nothing mounts there, and no env names it after this change. A later run
  rebuilds the farm without it.
- **The managed per-track tarballs lose their source** → the tarballs read a
  subtree out of a published variant image today. The replacement source is an
  open decision, and the tasks mark it `BLOCKED`.
- **The store-against-image compare loses its second artifact** → the compare
  builds the same manifest two ways. No image bakes packages after this change,
  thus the tasks mark the compare `BLOCKED` with its options.

## Migration Plan

1. Land the carry-forward and the track record in the provisioner. The change is
   additive: a farm with one track behaves the same as it does today.
2. Move the resolver env, the mount points, and the `packages.txt` producer into
   `sandbox-base`.
3. Build the conda prefix at `/opt/conda` and the Node packages at `/opt/node` in
   `sandbox-base`. Point the baked env and `mount-plan.ts` at the two paths.
4. Apply the three delta specs.
5. Remove `images/sandbox-python/` and `images/sandbox-python-r/`, and reduce the
   image build to one image.

Step 3 lands before step 5, because step 5 deletes the source of the two tracks.
A rollback of step 1 is a revert of the carry-forward. A rollback of step 5 is a
revert of the workflow and the Dockerfile removal. The two steps are independent.

## Open Questions

- Which artifact feeds the per-track tarballs of the managed mount, now that no
  variant image holds the tracks? The options are the content-addressed store, a
  builder tree that no image publishes, or a retirement of the tarballs with the
  managed delivery change. Marked `BLOCKED` in the tasks.
- What does the build compare a store against, now that no image bakes the same
  package set? The options are a comparison against the last published store, a
  comparison against a throwaway builder tree, or a retirement of the requirement.
  Marked `BLOCKED` in the tasks.
