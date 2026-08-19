# Grill round 3 — the reference tables

This document carries the material that the reply budget cannot hold. It
answers Q17 (the modes), Q18 (the conda boundary), and Q20 (the names).

## Q17 — the provision modes

The modes live in the provisioner image, behind its entrypoint. The CLI starts
the container and passes one mode (`spike:cli/src/modules/libs/store.ts:408`,
`:484`). Thus the user surface stays `inflexa store …`, and the mechanism stays
in the image.

| Mode | What it does | Caller today | Verdict |
| --- | --- | --- | --- |
| `build` | Resolve the manifest, install the closure, publish the catalog farm | The store build workflow | Keep |
| `acquire` | Install one requested package set into the pool | The CLI flights (`store add`) | Keep |
| `prepare` | Run the warm scripts against the catalog, record the cache entries | The store build workflow | Keep, per-package scripts (Q15) |
| `verify` | Confirm the store against the recorded hashes | Not confirmed in `cli/` or the workflows | The spec names a caller, or the mode dies |
| `repair` | Remove abandoned staging debris | Automatic at the start of each run (`eb768f93`) | Keep as internal step, drop the flag |
| `reclaim` | Remove unreferenced store directories | `inflexa store reclaim` (`store.ts:484`) | Keep |
| `remove-farm` | Delete one farm | The analysis delete flow (`store.ts:408`) | Keep |
| `add-lease` / `drop-lease` | Record a live sandbox on a farm | **None.** A grep of `cli/` and `harness/` finds no caller | Give the host a real caller, or the lease dies |

The lease finding matters: the farm-removal guard refuses while a lease holds
the farm (`spike:cli/src/modules/libs/composition.ts:1401-1441`). With no
writer, the guard guards nothing today.

## Q18 — the conda boundary, the context

What conda is here: the `system_tools` manifest track — bioconda command-line
tools such as `samtools=1.22.1` (`images/lib-store-manifest.yaml:613`). It is
not the Python track. Python installs with uv into the store.

What "the store" is: one host directory, mounted read-only at `/mnt/libs`.
The provisioner writes it, the OCI bundle delivers it, and each analysis farm
links into it.

Why conda cannot join the store model:

- A conda installation is one prefix: one directory tree whose files reference
  each other and the prefix path. Absolute paths bake into scripts and
  binaries at install time.
- Thus a conda prefix does not relocate, and it cannot divide into
  content-addressed per-package directories. Your research document records
  this limit ("conda/pixi prefixes are not freely relocatable").
- The farm model links single packages per analysis. A monolithic prefix
  cannot participate. Every analysis would share one conda either way.

The two possible homes:

- **(a) The image owns conda** at `/opt/conda`, built by a Dockerfile stage
  (`spike:images/sandbox-base/Dockerfile:77-98`). The spike shape. An update
  of a bioconda tool then requires an image rebuild and a pull. The tools ride
  the image digest pin and the droast scan.
- **(b) The bundle carries conda** as one blob at a fixed store path. A tool
  update then travels with a store download, and no image pull. But the blob
  is 1-2 GB in every bundle, it escapes the image scan, and the fixed-path
  constraint returns.

Recommendation: (a). The system tools change rarely, and the scan and the
digest pin are worth more than the faster update path.

## Q20 — the rename table

The term is **package store** (settled). The rule is actor plus action. The
config keys (`libStorePath`, `libStoreDir`, the lock keys) rename to
package-store forms in the spec table, with Q11's declared-facts field.

### Workflows

| Today | Purpose | After |
| --- | --- | --- |
| `lib-store.yml` | Build and publish the two images | `sandbox-images-build.yml` |
| `lib-store-provisioner.yml` | Build the store, warm the catalog, publish the bundle | `package-store-build.yml` |
| `lib-store-acceptance.yml` | Pull the published bundle and image, run the suite | `package-store-acceptance.yml` |

### The manifest and the locks

| Today | Purpose | After |
| --- | --- | --- |
| `images/lib-store-manifest.yaml` | The intent manifest | `images/package-store/manifest.yaml` |
| (new) | The per-arch resolved locks, committed back by the workflow (Q13) | `images/package-store/lock.<arch>.json` |

### In-image programs

| Today | Purpose | After |
| --- | --- | --- |
| `provision.py` | The provisioner entrypoint | `provision`, with subcommands (Q17) |
| `emit_deps.py` | Write `deps.json` | Keep, as `emit-deps.py` |
| `gen-r-lock.R` | Resolve the R track with pak | Keep |
| `inflexa-libs-refresh` | Rederive `packages.txt` and the fragments | Dies — `inflexa.lock` absorbs the inventory (Q14) |
| `inflexa-seed-caches` | Copy the caches to writable paths at sandbox start | Keep |

### Scripts and the rest

| Today | Purpose | After |
| --- | --- | --- |
| `images/lib-store-warm.py` | The one global warm workload | Dies — `images/package-store/warm/<package>.py` (Q15) |
| `scripts/lib-store-cache-check.py` | Replay the workload, confirm the cache hits | `scripts/package-store-warm-check.py` |
| `scripts/lib-store-r-load-check.py` | Load each R namespace in the sandbox | `scripts/package-store-r-load-check.py` |
| `scripts/lib-store-validate/` | Acceptance: each advertised module resolves from the store | `scripts/package-store-validate/` |
| `scripts/lib-store-sandbox-checks.sh` | Local rig, sandbox side | `scripts/package-store-check-sandbox.sh` |
| `scripts/lib-store-provisioner-checks.sh` | Local rig, provisioner side | `scripts/package-store-check-provisioner.sh` |
| `scripts/build-libs-local.sh` | Build sandbox-base locally | `scripts/sandbox-images-build-local.sh` |
| `scripts/lib-store-common.sh` | Helpers of the retired S3 path | Dies |
| `lib-store-publish.sh`, `lib-store-pack.sh`, `lib-store-write-manifest.sh`, `lib-store-write-packages.sh`, `lib-store-write-meta.sh` | The retired S3 tarball path | Die |
| `scripts/store-prototype/` | The stale prototype CLI | Dies |
| `.store-build-trigger` | The temporary branch trigger | Dies, never re-made |
| `droast.toml` | The scan overrides | Gains the provisioner Dockerfile (Q9) |
