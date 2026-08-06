# Roadmap: from the baked image to a Provisioner and a Sandbox

This roadmap tells you what to do to change the sandbox. Today one image holds
every package. The target is two roles: a **Provisioner** that builds a package
store, and a **Sandbox** that reads the store. This document uses Simplified
Technical English (ASD-STE100).

Each item has a status:

- **proven** — the prototype in this directory shows that it works.
- **designed** — an OpenSpec change specifies it, but no code exists.
- **open** — nobody has decided it or built it.

## 1. The goal

Split the sandbox into two roles.

- The **Provisioner** has a network and a build toolchain. It resolves packages,
  it compiles packages, and it writes them to the store. It never reads user data.
- The **Sandbox** has no network. It mounts the store read-only. It runs the
  analysis. Its security posture does not change.

The store is content-addressed. It holds each package one time. Two analyses that
use the same package share one copy.

## 2. Where we are now

### The image ladder (the "from" state)

Three images layer on each other:

- `images/sandbox-base/Dockerfile` — the lean base. It holds R, Python, Node,
  Chromium, and the Go `sandbox-server`. Its `/mnt/libs/current` is **empty**.
- `images/sandbox-python/Dockerfile` — it **bakes** the Python, conda, and Node
  packages into `/mnt/libs/current`. The image is 11.4 GB.
- `images/sandbox-python-r/Dockerfile` — it **bakes** the R packages on top. It is
  larger.

`images/lib-store-manifest.yaml` is the one list of packages. The workflow
`.github/workflows/lib-store.yml` builds and pushes the three images. It also
publishes per-track tarballs to S3 (`lib-store.yml:247`) for the managed service.
The target retires this S3 publish: Phase 4 delivers to the CLI from GHCR, and
Phase 5 gives the managed service its own delivery design.

### The mount seam already exists — **proven**

The harness can already mount a store. `createDockerSandboxOps` binds a host
`libStorePath` read-only at `/mnt/libs` (`harness/src/sandbox/docker-client.ts:314`).
The gate `libStoreUsable` (`docker-client.ts:126`) accepts the store only when
`current/` is a directory that holds `packages.txt` and `meta.json`. The CLI does
not pass `libStorePath` today, because it bakes the store into the image. The code
path is live but unused.

### The prototype proves the mechanism — **proven**

`scripts/store-prototype/` holds a runnable rig. It shows that:

- A compiled package moves to a new path and still loads. This includes vendored
  shared libraries that use `$ORIGIN`.
- The content address is stable. `provision.py` hashes the installed tree (the
  relative paths, the file bytes, the executable bit, the symlink targets). It
  excludes bytecode and JIT caches.
- The store removes duplicates. A store of 52 packages is 776 MB. A second scanpy
  analysis adds only 8 MB.
- The symlink farm costs about 3% of import time. The earlier "2.4×" cost came
  from virtiofs on macOS, not from the design.
- The acceptance suite passes 15 of 15 checks on linux/arm64.

The prototype report says it well: "The prototype proves the mechanism. It does
not prove the product."

### The design exists but no code exists — **designed**

Three OpenSpec changes specify the product. Every task is unchecked:

- `harness/openspec/changes/content-addressed-lib-store/` — the store format and
  the Provisioner. **78 tasks, 0 done.** Aligned to pak (U0, 2026-08-04): the R
  step no longer says "r2u, then split" — pak installs, `gen-r-lock.R` splits, and
  the retired recipe-schema line is corrected.
- `harness/openspec/changes/manifest-package-recipes/` — a recipe schema for the
  manifest. **Retired.** renv's lock file is the recipe, so we do not build this
  schema. See Phase 1 and the PRIOR-ART report.
- `cli/openspec/changes/lib-store-mount-and-provisioning/` — the CLI that mounts
  the store and runs the Provisioner. **20 tasks, 0 done.**

## 3. The end state

Two Dockerfiles hold the two roles:

- `images/sandbox-provisioner/Dockerfile` (**new**) — the Provisioner. It comes
  `FROM` the same digest-pinned base as `sandbox-base`, so the compiled packages
  match the runtime ABI. It adds the toolchain, `uv`, and the store logic.
- `images/sandbox-base/Dockerfile` (**exists**) — the Sandbox. It mounts the store.
  It does not change its security posture.

The baked images (`sandbox-python`, `sandbox-python-r`) stay for now. The store is
**additive**. It does not replace the baked image. A later decision (see §8) can
retire the baked path.

The store layout is:

```
store/<name>-<version>-<hash16>/   content-addressed, write-once
farms/<analysis>/                  the symlinks for one analysis
current -> farms/<analysis>        the pointer that libStoreUsable resolves
```

### The model — how to think about it

Two axes are separate. Do not mix them:

- **Declaration** — how we record what to install. Today it is shell in the
  Dockerfile. The target is a lock file (renv for R, uv for Python). The lock is
  the recipe.
- **Delivery** — where the packages land. Today they bake into the image. The
  target is the store, mounted read-only.

The same lock feeds both. The baked image reads it now. The Provisioner reads it
later.

**The catalog is a seed, not a wall.** The Provisioner has a network and a
compiler. So it can build a package that the catalog does not hold.

- A **normal** package (PyPI, CRAN, Bioc, GitHub) needs only its name. The
  Provisioner resolves it, builds it, and adds it to the store.
- A **special** package (an odd source or a git pin, like DEP) needs a recipe: the
  source and the pin. This is the DEP path.

**An upgrade adds. It does not overwrite.** The store path holds the version and a
content hash. So version X and version X' get different directories. They coexist.
An upgrade builds X' and re-points the farm. The old version stays until retention
removes it. An upgrade re-resolves the lock; it is not a silent bump.

**The store is built one time, on CI, and then downloaded.** A user machine never
builds the catalog. A full R build takes about 1h35m, thus no user waits for it. The
CI build also warms the numba and matplotlib caches into the farm.

**The warmed caches travel with the store.** `provision.py:567-568` writes them into
the farm, and `provision.py:560-564` warms through `/mnt/libs/current`, because the
numba cache key holds the source path. That path is a fixed mount contract, and
`NUMBA_CPU_NAME` is `generic` on arm64. Thus the keys match on any machine, and a
user never pays the 10 to 20 minutes that a cold cache costs
(`images/sandbox-python/Dockerfile:194-197`).

**The Provisioner runs on a user machine only to add a package.** It resolves one
package and its closure, installs it, and warms that package. The warm covers only
what the warm script exercises, because numba compiles at the first call and not at
the import (`provision.py:555-558`).

**A user drives an upgrade through a user-facing tool.** That tool is deferred
(Phase 4 and §8).

## 4. The roadmap

Do the phases in order. Phase 1 is a prerequisite for the R part of Phase 2. Phase
4 needs a released harness from Phase 2 and Phase 3.

### Phase 1 — Move the R track to a lock file (harness)

**Goal.** The Provisioner must reproduce every install. A package whose
instructions live as shell in a Dockerfile cannot move to the Provisioner. Record
the R track as a lock file instead. The lock file is the recipe.

**The engine is pak; "renv" was the umbrella term.** The spike (RENV-SPIKE.md) and
the resolution work both use pak. Only `pak::lockfile_create` resolves the mixed
track (CRAN, Bioc, a git pin) into a lock WITHOUT a compile. So the concrete lock
is a pak lockfile. The PRIOR-ART rule still holds: use a lock file, not a schema.

**The same lock feeds both roles.** The baked image reads the lock now. The
Provisioner reads the same lock later. So the work is not throwaway.

**DEP is one entry, not a special case.** DEP is only the first R package that
breaks a batch install: it is not on CRAN, not in Bioc 3.23, and not on github.com.
It is on git.bioconductor.org. pak records it as one git entry, pinned to the
commit. DEP 1.32.0 now sits in the bulk lock, not in a shell branch
(`images/sandbox-python-r/Dockerfile:231` today).

**Two units, not one lock. [measured]** A single global lock for all three tracks
does NOT solve. The GitHub track breaks it: `azimuth` needs `SeuratData` (a ref pak
cannot find), and some GitHub packages demand a newer `survival`/`nlme`/`mgcv` than
the base. The current build already avoids both — it stages GitHub last and installs
on top of a fixed base. So the R track is two units:

- **The bulk lock** — CRAN + Bioc + DEP. It solves cleanly: a 719-package closure
  with one git entry (DEP 1.32.0). This is 152 of the 167 named packages.
- **GitHub, incremental** — the current stage stays. It follows `Remotes:`, takes
  the base versions, and does not join the lock. Pinning GitHub commits for
  reproducibility is a later refinement.

**The system-library gap is not a manual cost. [measured]** pak reads each package's
`SystemRequirements` and installs the missing apt packages itself, as root (see
RENV-SPIKE.md). One duty stays: the sandbox needs the runtime libraries, which pak
installs as `-dev` in the builder only.

**Keep the subtree split.** The bulk installs into one staging library, then a sort
by REACHABILITY places each package: the closure of the CRAN refs goes to `r/cran`,
everything else installed goes to `r/bioconductor` (DEP included). This mirrors the
old two-stage build — the CRAN stage installed its closure first — and keeps the
`r/{cran,bioconductor,github}` layout that the store and the managed mount expect.
The lock `type` cannot do this: pak types a Bioconductor package `standard` when P3M
mirrors it, so type does not separate the two.

**Do not use a build system** (conda-build, Nix, Spack). conda-build compiles a
package in its build prefix, which stops the package from moving to the store.

**Steps.**

1. **Done** — retire `manifest-package-recipes`, update this roadmap, flag the r2u
   step in `content-addressed-lib-store`.
2. **Done** — spike pak on P3M binaries (RENV-SPIKE.md); prove the whole track
   resolves; bisect the conflicts to the GitHub track; produce the bulk lock.
3. **Done** — the build generates the bulk lock in-stage, per arch, from the manifest
   (`images/gen-r-lock.R`). Not checked in: a pak lock records a per-package platform,
   so one lock cannot serve both arches. The pinned P3M snapshot keeps the in-build
   resolve reproducible. DEP moves into a manifest `r.git` entry (name, url, commit,
   reason).
4. **Done** — the `rlibs` stage runs `pak::lockfile_install` and splits the result
   into `r/cran` / `r/bioconductor` by the CRAN-ref closure. pak installs the system
   libraries itself. r2u is dropped; both arches use one pak path. The coverage report
   folds the git names into the Bioconductor wants.
5. **Done** — the GitHub stage is unchanged and now builds on `rlibs`. The DEP shell
   branch is gone.
6. **The CI gate — on `main`, post-merge.** Build the whole image and show the package
   set matches the current build. Status:
   - **Committed and pushed** (PR #291, commit `9c66f282`); DCO, lint, and version-guard
     pass.
   - **Verified as far as is practical locally**: the mechanism end-to-end on a small
     manifest (DEP placed in `r/bioconductor` and loaded), plus the full 719-package
     resolution (the bulk lock). The real local build ran clean through hundreds of
     packages into the Bioconductor compiles — no code error surfaced.
   - **Blocked locally by the environment, not the code**: at 5.5 GB the VM OOM-killed
     an R build (kernel-confirmed: one package reached 2.36 GB). Raising the VM to 10 GB
     removed the OOM; the build was then stopped by the environment's ~20-25-minute
     background-task cap, which a 60-90-minute serial build cannot beat.
   - **The full build+publish runs on `main`**: `lib-store.yml` is `workflow_dispatch`
     only, on self-hosted EC2 builders (~1h35m), and it publishes to GHCR/S3. It is not
     branch-scoped, so it runs after merge, with the builders started (`just build-start`).

**Value.** This phase improves the current image build. It does not need the store.
It also produces the lock that Phase 2 reads.

### Phase 2 — Build the content-addressed store and the Provisioner (harness)

**Goal.** Build the store format and the Provisioner container. Turn the prototype
(`scripts/store-prototype/provision.py`, `inflexa-store`, `provisioner.Dockerfile`)
into product code. Nothing consumes the store yet.

**Status: approved on 2026-08-04, not started.** Every unit below is **designed**; no
product code exists.

**The gate — U0 first.** The Phase 2 OpenSpec change (`content-addressed-lib-store`)
still told the R track to "keep r2u, then split". Phase 1 removed r2u. So the design of
record was wrong. U0 aligns it to pak before any code. The same edit retires the
"recipe schema is a sibling change" line, because Phase 1 retired that schema (the pak
lock is the recipe).

**The units.** Each unit is one reviewable piece. Every code unit lands in
`images/sandbox-provisioner/`, the Provisioner image; the harness `src` change is the
agent-facing text only.

| Unit | What it builds | Depends on | Where |
|-|-|-|-|
| U0 Spec align | Fix r2u -> pak and the retired-schema line in the change | — | harness/openspec |
| U1 Supply chain | `--generate-hashes`, one pinned index, egress allowlist, a `verify` op | U0 | images/sandbox-provisioner |
| U2 Provisioner image | Promote `provisioner.Dockerfile`; assert base digest = `sandbox-base` | U0 | images/sandbox-provisioner |
| U3 Store format | Tree hash, write-once dir, publish by rename, reuse lookup, staging repair | U2 | images/sandbox-provisioner |
| U4 Resolve + install | `uv pip compile` (hashes from U1), install per pin, verify the artifact | U1, U3 | images/sandbox-provisioner |
| U5 Farm assembly | Link entries, promote collisions, hoist scripts, write meta.json/packages.txt, flip `current` | U3 | images/sandbox-provisioner |
| U6 Cache prep + seed | numba/matplotlib through `current`; seed in `sandbox-entrypoint.sh` | U5 | images/sandbox-provisioner + images/sandbox-base |
| U7 R track | Reuse `gen-r-lock.R`; content-address each package dir; farm into r/{cran,bioconductor,github} | U3, U5 | images/sandbox-provisioner |
| U8 Concurrency + disk | Per-store lock; refuse re-point while a Sandbox mounts the store; reclamation op | U5 | images/sandbox-provisioner |
| U9 Text + specs | Apply the lib-store / lib-store-build deltas; the new lib-store-provisioner spec; correct the agent-facing text | U0 | harness/openspec + harness/src |
| U10 CI emit | Push the store to GHCR with ORAS; build the Provisioner in the workflow | U2..U8 | .github/workflows |

**Order.** U0 -> U1 -> U2 -> U3 -> (U4, U5) -> U6 -> U7 -> U8 -> U9 -> U10.

U1 hardens the provision program where it lives today
(`scripts/store-prototype/provision.py`, `inflexa-store`); U2 relocates the hardened
program to `images/sandbox-provisioner/`, so the two units share that end location.
The container-level egress firewall is the one U1 guarantee that lands with the image
in U2, not in the program.

**Trade-offs (decided in shape).**

- **Supply chain first.** The content address finds corruption; it does not stop a
  swapped upstream file. `--generate-hashes` plus a pinned index close the gap, so
  every install path is hash-checked from the start. A dependency without a published
  hash must fail loudly, not skip.
- **Reuse `gen-r-lock.R`.** Phase 1 already resolves, installs, and splits the R track.
  U7 adds only two things: content-address each package dir, then farm it. The lock
  feeds both roles — the rule from §3.
- **Keep the Provisioner in Python.** The prototype works; uv and pip are Python. The
  Provisioner is a container program, not harness host code, so it does not enter the
  TypeScript harness. The only harness `src` change is the agent-facing text (U9).
- **CI cost is real.** A true test builds the store with the Provisioner, not from the
  baked tree. That adds a second long build, but Phase 3 needs both artifacts to
  compare them.
- **The "mounted" check splits across phases.** U8 builds the lock and the refusal
  contract. The "is a Sandbox using the store" answer needs host knowledge, which
  arrives with the CLI in Phase 4. Phase 2 ships the mechanism, not the host wiring.

**The §9 tests split.** The unit-level tests (a tampered hash, an interrupted run, two
Provisioners at once) stay in Phase 2. The store-vs-image compare, the ~500-package
scale test, and the Linux timing move to Phase 3.

**Open decisions do not block this phase.** "Replace or augment" is decided (additive).
Retention gets a reclamation *operation* here; the *policy* waits. The lock is written
regardless; whether the analysis record keeps it is a Phase 4 choice. Per-analysis
farms and the Kubernetes storage class are non-goals here (§8).

**The U10 questions are decided (2026-08-05).** The store builds in a new, dedicated
workflow, not in `lib-store.yml`. The honest test builds the store with the
Provisioner, and Phase 3 compares both artifacts. The publish target is GHCR
through ORAS, not S3. See Phase 4.

**A live run on 2026-08-05, with podman on macOS, on linux/arm64.** The provisioner
image builds, and the store that it makes loads in a real sandbox. These parts passed:

- the image build, at 1.85 GB, and the base-digest assertion against the manifest
- the hashed resolve and install, first for one package, then for a scanpy closure of
  48 distributions
- the content address, the pin marker, and the source hashes in the lock file
- reuse across two farms, with one copy of the shared package
- the acceptance suite in the sandbox, at 15 of 15, with no network, with uid 1000,
  and with a read-only store
- a compiled C extension, which loads through the farm, and scipy, which resolves its
  vendored libraries through `$ORIGIN` across a symlink
- the per-store lock, which refused a second provisioner and a reclaim, with exit 1
- the lease guard, which refused the re-point, with exit 1 and no move of `current`
- `remove_farm`, which refused the farm that `current` selects
- `reclaim`, with a correct count, and scanpy still imports after it
- the store check, which named the tampered directory and the two hashes, with exit 1

**The run found one defect and two smaller items.**

1. **A stopped run destroys the record of a farm.** `build_farm()` removes the whole
   farm directory, and the run writes `lock.json`, `meta.json`, and the packages.txt
   only at the end. A stop between those two points leaves the links and no records.
   The lease guard is the probable trigger, because a refused re-point is a designed
   outcome and not an error. Two effects follow. The requested set is gone, thus a
   later run answers "nothing to do". And `libStoreUsable` refuses a farm that holds
   no packages.txt and no meta.json, thus the harness drops the mount without a word.
2. A failed resolve prints a raw Python traceback, and not a clear message.
3. `inflexa-store verify` reports "no store" for a store root that holds no `store/`
   directory yet, instead of an empty store.

**One note about the environment.** On macOS a container that starts right after a
host write sometimes reads the old bytes. Thus the store check can report a stale
pass. A read from any container refreshes it. A Linux bind mount does not behave this
way, thus CI and production do not see it.

**Not yet run.** The R track, the cache warm-up with the seed in the entrypoint, and
the CI workflow. The R track needs the full pak build, which does not fit the memory
of this machine. CI is the place for it.

### Phase 3 — Verify the store against the baked image (harness)

**Goal.** Prove that the store gives the same environment as the baked image.

**Steps.**

1. Build the same package set two ways: the store and the baked image.
2. Compare them. The versions must agree. The import results must agree. Name any
   package that differs.
3. Port the prototype acceptance suite. Run it on amd64.
4. Test the hard cases: an interrupted run, a tampered hash, a full disk, two
   Provisioners at once, and a store of about 500 packages.
5. Re-measure the import time on Linux, not on macOS.

This phase is the gate. Do not flip a consumer to the store until it passes.

### Phase 4 — Deliver the store to a machine, and flip the CLI to it (ci + cli)

**Goal.** Put the store on a user machine, and let a user opt in to it. Keep the
baked image as the default.

**How the store travels: a GHCR artifact, not an S3 archive. [decided 2026-08-05]**
An earlier draft said "GHCR holds images, and the store is not an image". That claim
was wrong. GHCR accepts a non-image OCI artifact through an ORAS push. Helm charts
travel this way, and Homebrew serves every binary bottle from ghcr.io, anonymously
and at large scale. This is the exact use case: binary packages from a registry.

The shape of the artifact:

- One artifact for each architecture: `ghcr.io/<org>/lib-store:<version>-<arch>`.
  Each track is one layer. The limit is about 10 GB per layer, and a compressed
  track stays far under it.
- The OCI manifest replaces `manifest.json`. Each layer descriptor carries its
  sha256 digest, thus the integrity model does not change.
- A blob is immutable by its digest, which keeps the write-once rule. A
  `latest-<arch>` tag, or one multi-arch index, replaces the `latest/` pointer.
- An anonymous pull of a public package works without an account: a token GET,
  then a manifest GET, then a blob GET, all over https. The documentation names no
  pull rate limit for a public registry, but no staff statement confirms it. Thus
  the guarantee is practical, not contractual.

One host then serves the image and the store, on the same CDN domain. Thus the user
sees one source, and one egress domain is the whole allowlist.

The CLI already holds the client pattern, for reference data:

- `cli/src/lib/download.ts` gives `downloadToFile`. It retries, it records a sha256,
  it writes to a stage path, then it renames. A layer download is a plain https GET,
  thus `downloadToFile` serves it as it is. The bearer token enters through the
  injectable `fetch` seam, because the utility itself sends no headers. GHCR answers
  a blob GET with an https redirect to a GitHub CDN host, and the
  `insecure_redirect` check accepts an https redirect.
- `cli/src/modules/refs/store.ts` installs a dataset onto the user filesystem with a
  receipt. It already models the states `missing`, `installed`, `update_available`,
  `partial`, and `invalid_receipt` (`store.ts:47`).
- The registry client above `downloadToFile` is small: a token GET, a manifest GET,
  and a digest compare. It is roughly one hundred lines, with no docker dependency.

The S3 tarballs do not join this design. They stay only as the current mechanism for
the managed service, until Phase 5 replaces them. The CLI channel carries no
compatibility duty toward S3.

**The download must not block the app.** Today `cli/src/tui/app.launch.tsx:48` and
`cli/src/modules/harness/chat.ts:96` both wait for the image pull. So a user cannot
say anything until a multi-gigabyte download completes. A second download makes that
worse. Chat, the workspace read surface, and the planner do not use a sandbox, thus
they must start at once.

**A gate on the download is necessary, not a refinement.** `docker-client.ts:126`
`libStoreUsable` reports false for an incomplete store, and `:285` then drops the
mount. Today that state reports a broken store. With a download in the background it
becomes a normal temporary state. Thus an analysis that starts too early runs a
sandbox with no packages, and nothing reports it.

**Steps.**

1. Publish the store from CI to GHCR, with ORAS, as one artifact for each
   architecture.
2. Add a store-root config key. Keep it separate from `libsDir` (the per-image
   cache).
3. Pull the artifact at app open, in the background, with the receipt pattern of
   the reference store.
4. Hold each action that makes a sandbox until the receipt reports a complete store.
   Report the state to the user. Do the same for the image pull.
5. Pass `libStorePath` when a store is configured. Let the harness mount it. Do not
   re-implement `libStoreUsable`.
6. Point `packagesFile` at the store's active farm when a store is configured.
   Point it at the image cache when no store is configured.
7. Add the provisioning commands. Run the Provisioner through `src/lib/container.ts`.
   Give the network commands the `approval` policy. Keep listing on `auto`.
8. Seed the prepared caches in `images/sandbox-base/sandbox-entrypoint.sh`.
9. Correct the agent-facing text. The old text says that a package install is
   impossible (`list-available-packages.ts:209`, `sandbox-standards.ts:94`, the
   `packages.txt` header). An install is now a host action.
10. Resolve the spec contradiction. One spec forbids the `/mnt/libs` bind. The other
    spec requires it.

The config defaults to **off**. A rollback clears the config. The baked image does
not change.

**What this phase does not do.** It downloads the whole store. The image drops from
11.4 GB to 2.34 GB, and the store carries that difference as a separate download, so
the total bytes stay about the same. To fetch only the store directories that a farm
names is the size gain, and it is a later decision (§8). The OCI model prepares
that path, because each store entry can become its own blob, and a client fetches a
blob by digest.

### Phase 5 — The managed service (Kubernetes) — later, decoupled

**Goal.** Bring the store to the managed service, with its own delivery design.

**The managed service is not a constraint. [decided 2026-08-05]** The design of the
CLI channel (Phase 4) serves the CLI alone. The managed service consumes the S3
per-track tarballs today, and that publish stays only until this phase replaces it.
No CLI decision waits for compatibility with the managed path.

**Steps.**

1. Decide the delivery: pull the same GHCR artifact from the cluster, or a
   different mechanism. The store format is the shared contract, not the channel.
2. Decide the storage class. `ReadWriteOnce` binds the volume to one node. The
   managed service needs `ReadOnlyMany` or `ReadWriteMany`.
3. Add the store check to the Kubernetes backend. The Docker backend has
   `libStoreUsable`. The Kubernetes backend (`k8s-client.ts:86`) does not.
4. Mount the store volume claim.
5. Retire the S3 tarball publish from `lib-store.yml`.

This phase waits for the storage-class decision.

## 5. The critical path

```
Phase 1 (renv R track)  ->  Phase 2 (store + Provisioner)  ->  Phase 3 (verify)  ->  Phase 4 (deliver + CLI opt-in)
                                                                                        |
                                                                        Phase 5 (managed, after a decision)
```

Phase 4 holds both halves of delivery: CI publishes the artifact to GHCR, and the
CLI pulls it. Neither half exists. The mount that reads the result exists already.

The CLI change (Phase 4) needs a released harness. The CLI CI is red until the
harness release ships. This is the normal shape of a change across the two
subsystems.

## 6. What this session already did

- It removed the ANCOMBC and MSstats build exceptions (commit `151f70c3`).
- It hardened DEP to a git commit pin and removed CVXR (commit `8c795365`).
- It proved that all four R packages install on R 4.6 and Bioc 3.23.
- It chose a lock file (pak) as the R declaration, and retired the recipe schema.
- It proved the spike: pak builds from a lock on P3M binaries and auto-installs the
  system libraries (RENV-SPIKE.md).
- It resolved the whole R track through pak. The CRAN + Bioc + DEP bulk locks
  cleanly — a 719-package closure with one git entry (DEP). GitHub must stay
  incremental (a global solve conflicts on `SeuratData` and `survival`/`nlme`/`mgcv`).
- It built Phase 1: DEP became a manifest `r.git` entry, the r2u/BiocManager R stages
  became one pak `rlibs` stage (`images/gen-r-lock.R`), r2u is dropped, and the
  coverage report folds the git names. `gen-r-lock.R` is verified end-to-end on a
  small manifest.
- It committed and pushed Phase 1 (PR #291, commit `9c66f282`). The local full build
  was blocked by the environment — an OOM at 5.5 GB (fixed at 10 GB), then a
  ~20-25-minute background-task cap — not by the code, which ran clean through hundreds
  of packages. The full build+publish is the manual `lib-store.yml` dispatch on `main`.

**Effect on the roadmap:** Phase 1 moves the R track through a pak lockfile, not a
recipe schema. The recipe schema is retired, not deferred. DEP becomes one git entry
in the bulk lock. GitHub does not join the lock; it stays incremental, as it is now.

## 6a. What the overnight loop did (2026-08-06)

The loop took the three changes through `/opsx:explore`, the artifact audit,
`/opsx:apply`, `/opsx:verify`, `/opsx:sync`, and `/opsx:archive`. Opus workers
wrote the code, and each diff passed a judgment before its tasks marked. The archives are:

- `harness/openspec/changes/archive/2026-08-06-content-addressed-lib-store`
- `cli/openspec/changes/archive/2026-08-06-lib-store-mount-and-provisioning`
- `cli/openspec/changes/archive/2026-08-06-lib-store-download`

CI-only work stays: the store-against-image compare, the 500-package scale test,
the amd64 run, the Linux import timing, the full R build, and the first store
publish (a manual dispatch of the new workflow). Blocked decisions stay: the
provisioner-image source for a user machine, and the disk retention across store
versions. The harness version bump is release-gated.

## 7. What is proven, designed, and open

| Area | Status |
|-|-|
| Package relocation, dedup, symlink farm, cache prep | proven |
| Store format, Provisioner, CLI mount | built and archived (2026-08-06). The four CI-marked runs stay |
| Supply-chain pinning, per-store lock, staging repair | built and checked in a container, not shipped |
| Delivery of the store to a machine (a GHCR artifact, the ORAS push, the CLI pull, the gate) | built and archived (2026-08-06). The first publish waits for a dispatch |
| Lock the R track (pak) | bulk CRAN+Bioc+DEP resolves (719 pkgs); GitHub stays incremental; ready to wire |
| R system-library gap (r2u installs these; P3M does not) | measured; pak auto-installs via apt, no manual list |
| Recipe schema (`manifest-package-recipes`, 21 tasks) | retired; the pak lock is the recipe |
| Kubernetes storage class and store check | open |
| Replace or augment the baked image | open |

## 8. The decisions to make

Make these decisions early. They gate the work.

1. **Replace or augment.** Does the store replace the baked image, or does it add
   to it? The additive path is safer. It keeps a working fallback.
2. **Storage class.** Which Kubernetes storage class does the managed service use?
   This gates Phase 5. It does not gate the CLI channel.
3. **Per-analysis or per-installation store — decided (2026-08-05).** The store
   is per-installation. One `current` pointer gives one active farm. A
   per-analysis store waits for the per-sandbox mount work.
4. **Retention.** How long does the store keep a package that no current farm uses?
   An old analysis may need it again.
5. **Version choice — decided in shape.** The lock file pins the version, for
   reproducibility. A user upgrades through a user-facing tool, which re-resolves
   the lock. That tool is deferred (Phase 4).
6. **Provenance.** Does the analysis record keep the lock file? The lock file is the
   only artifact that reproduces the environment later.
7. **renv install method — decided.** The spike (RENV-SPIKE.md) proved renv + pak
   on P3M binaries. pak also fills the system-library gap by itself (`apt`, as
   root), so no r2u hybrid is needed. One duty stays: the sandbox still needs the
   runtime libraries, which pak installs as `-dev` in the builder only.
8. **The whole store, or the subset that a farm names.** A download of the whole
   store is simple, and the image still drops from 11.4 GB to 2.34 GB. But the bytes
   on disk stay about the same. To fetch only the store directories that a farm
   names is the real size gain. That path adds two parts: an index of the store, and
   a fetch that reads a farm lock. The OCI choice prepares it, because a registry
   serves each blob by digest.
9. **The size of the catalog.** We chose 167 R packages and 108 Python specs because
   a user could not add one. Once a user can add a package in minutes, the catalog
   can hold a small core instead. This decision changes the size more than any other
   item in this plan.
10. **The delivery channel — decided (2026-08-05).** The store travels as an OCI
    artifact on GHCR, through an ORAS push. One host serves the image and the store.
    S3 stays only for the managed service, until Phase 5 retires it.
