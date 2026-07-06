## Why

Setup is the friction point. Today the sandbox image carries **no** analysis
packages — they live only in an externally-built library store that a user must
`inflexa libs pull`, assemble, and mount before anything works. That indirection
is right for the managed service (a read-only mount avoids re-pulling a multi-GB
image on every new node — the cold-start argument), but it is a poor first-run
experience for an open-source user who just wants a sandbox that works.

We want both: a **one-`docker run`** experience for users *and* the mounted store
for managed cold-starts, from a **single source of truth**. The move is to make
the packages ship as **three layered, publicly published images** — and to make
the managed-mount tarballs a **byproduct extracted from those images** rather
than a separately-built artifact. One build produces both consumers.

Two secondary problems get fixed in the same stroke:

- **arm64 R was deferred entirely.** The store is per-arch and arm64 published no
  R at all. We now attempt every track on both arches **best-effort** — arm64
  ships whatever R actually builds — instead of an all-or-nothing R gate.
- **"Gate 1 / Gate 2" is opaque** in prose and in code. It becomes semantic:
  **load check** (build-time), **coverage report** (want-vs-got table), and
  **acceptance** (as-a-user, gates promotion).

## What Changes

- **Three layered images are the primary published artifact.** `sandbox-base`
  (lean runtimes + `sandbox-server` + provenance, no analysis packages) →
  `sandbox-python` (adds the Python libs **and** the bioconda CLI tools + Node
  packages) → `sandbox-python-r` (adds the R libs). Published for
  `linux/amd64` **and** `linux/arm64` to **GitHub Packages (GHCR) on the
  `inflexa-ai/inf-cli` repo** (`ghcr.io/inflexa-ai/inf-cli/<image>`), each with a
  committed Dockerfile users can edit or `FROM`. Base stays lean so managed
  cold-start is unchanged; the conda CLI tools ride up into `sandbox-python`
  (kept out of base for exactly that cold-start reason).

- **Every layer installs into `/mnt/libs/current/…`** — the same path the
  managed mount uses. A baked image and a mounted store are therefore a
  **byte-identical runtime layout**, so the harness `lib-store` runtime contract
  is untouched.

- **Images are self-sufficient.** Each image bakes the resolver env
  (`R_LIBS_SITE`, `NODE_PATH`, `PATH` incl. the conda `bin`, the Python `.pth`)
  and a `/mnt/libs/current/packages.txt` so a plain `docker run` — with no
  harness and no mount — resolves imports and answers `list_available_packages`.

- **`FROM`-extension is a first-class path.** A single `INFLEXA_LIB_ROOT` plus
  per-installer target env (`PIP_TARGET`, `R_LIBS_USER`, npm prefix) makes a
  downstream `RUN pip install …` / `install.packages(…)` / `npm install …` land
  in the store and resolve at runtime with no path knowledge, plus a helper that
  refreshes `packages.txt` so additions show up in discovery.

- **The managed-mount tarballs are extracted from the published images.** After
  the images publish, the build tars each track subtree out of the image, hashes
  it, and publishes the same per-track, content-addressed tarballs + per-arch
  manifest + `latest` pointer the managed mount already consumes. Dedup-by-digest
  and immutable versions are preserved; only the *source* of the tarball changes
  (image layer subtree instead of a throwaway builder's track subtree).

- **Verification is best-effort with a floor and a report, renamed to be
  semantic.** The **load check** (was Gate 1) still `import`/`library()`/
  `require()`s each package and derives `packages.txt` from what loaded, but a
  single package failure no longer fails the track — only a track that loaded
  **zero** packages fails (the non-empty floor), so we never ship a degenerate
  tarball. A **coverage report** prints want-vs-got per arch × track and diffs
  against the last published manifest: an amd64 package that silently drops is a
  regression (red), an arm64 package that never built is tolerated. **Acceptance**
  (was Gate 2) still pulls as a user on a fresh machine and gates `latest`.

## Capabilities

### Modified Capabilities

- `lib-store-build`: the build/publish contract gains the three-image topology
  and the "tarballs extracted from images" model; the per-arch track set becomes
  best-effort (arm64 may now carry R); the two numbered gates become the
  semantic load check / coverage report / acceptance, with the load check
  relaxed to best-effort + non-empty floor + regression diff; and the images'
  runtime self-sufficiency (baked resolver env + `packages.txt`) and
  env-driven `FROM`-extension become part of the build's contract.

### Companion change (cli subsystem)

- `lib-store-provisioning` (cli): **substantially changed — its own
  `cli/openspec` change, tracked here as a dependency.** The CLI stops pulling
  and assembling tarballs for local users. Instead the user chooses an image
  variant (`python` or `python-r`), the CLI `docker pull`s that image from GHCR,
  and points `harness.sandboxImage` at it so sandboxes launch on the baked image
  — no local store dir, no `/mnt/libs` bind mount, no client-side `packages.txt`
  assembly. The per-track tarball machinery (`src/modules/libs/*`) is retired for
  the local path; the tarballs remain **managed-only** (mounted via the
  Kubernetes PVC by infra, not by the CLI).

### Unmodified

- `lib-store` (harness runtime mount contract): **unchanged.** The store is still
  a read-only `/mnt/libs/current` with one `packages.txt` and the same resolver
  env; `list_available_packages` is unchanged. A baked image satisfies the same
  contract without a mount because it populates the same paths and bakes the same
  env — self-sufficiency is a property of the *image* (owned by `lib-store-build`),
  not a new harness behavior. Managed still mounts the extracted tarballs at the
  same path.

## Impact

- **Images** (`images/sandbox-base/Dockerfile`, new
  `images/sandbox-python/Dockerfile`, `images/sandbox-python-r/Dockerfile`):
  the package installs move out of the throwaway `lib-store-builder` into the
  layered runtime Dockerfiles, targeting `/mnt/libs/current/…`; each bakes the
  resolver env + `packages.txt`; base stays analysis-package-free.
- **Build/publish** (`.github/workflows/lib-store.yml` and scripts): build +
  push the three images per arch to `ghcr.io/inflexa-ai/inf-cli/*` (GitHub
  Packages on this repo); extract per-track tarballs from the images; keep the
  immutable-version + per-arch manifest + content-addressed publish. Load check
  runs inside each image build; the coverage report is emitted after; acceptance
  stays a separate workflow.
- **Verification** (`scripts/lib-store-validate/`, `lib-store-gate2.sh` →
  `lib-store-acceptance.sh`): rename off the numbered gates; the load-check
  helpers go best-effort with a floor; a new coverage-report step; acceptance
  now boots each published **image** directly (baked, no mount) — the artifact
  OSS users actually consume — and still validates the managed mounted tarballs.
- **`lib-store-builder`**: absorbed. Its manifest (`lib-store-manifest.yaml`, the
  package set source of truth) survives and is consumed by the layered image
  builds; the builder-only Dockerfile is retired in favor of the three runtime
  Dockerfiles.
- **Cleanup pass** — a sweep over `scripts/lib-store-*`, `images/*/Dockerfile`,
  and the workflows to delete machinery the new model orphans (client-side
  tarball assembly for the local path, the builder Dockerfile, the numbered-gate
  naming, and any staging/track logic that only fed the old builder). The
  managed tarball extract + publish scripts stay; the local-assembly scripts go.
- **CLI** (`cli/`, companion change): `harness.sandboxImage` becomes the pull
  target; `ensureSandboxImage` `docker pull`s from GHCR instead of telling the
  user to `docker build`; a variant chooser (`python` / `python-r`); the
  `src/modules/libs/*` tarball client is retired.
- **arm64 R** is now *attempted*. **How** arm64 is built (native runner vs.
  emulation on the amd64 host) is an infrastructure decision, out of scope here —
  this change only requires that both arches attempt every track best-effort and
  publish what passes the floor.
- **Docs**: `images/*/README.md` gain the layered-image + `FROM`-extension
  story; the CLI setup docs note the image path as the zero-pull option.

## Out of Scope / Deferred

- The arm64 build **mechanism** (native arm64 runner vs. QEMU emulation on the
  amd64 self-hosted box) — infra's call; the spec is mechanism-agnostic.
- Per-track independent versioning (a python-only bump without rebuilding R) —
  the manifest already leaves room; not wired here.
- Nightly re-validation of `latest` against a drifting base image / R denylist.
