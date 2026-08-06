## Context

The library store is currently baked into the sandbox image. `sandbox-python` measures 11.4 GB. The image is the unit of distribution, of versioning, and of change: adding one package means rebuilding and re-pulling all of it, and a user cannot add one at all.

A working prototype lives at `scripts/store-prototype/`, with its measurements in `PRODUCTION-READINESS.md`. Every number quoted below was measured on linux/arm64 against `ghcr.io/inflexa-ai/sandbox-base:latest`, not estimated. The prototype is standalone: it touches no harness or CLI code, because the mount seam it needs already exists.

The security constraint is unchanged and non-negotiable: the sandbox has no network, runs as uid 1000, drops all capabilities, and sees the store read-only. What this design separates is *who may reach a network* from *what the sandbox may do*.

## Goals / Non-Goals

**Goals:**

- One copy of a package version per machine, shared by every analysis that resolves to it.
- An analysis materialises only its own dependency closure.
- A user can add a package without the sandbox ever gaining a network.
- The runtime layout is byte-identical to what the images bake today, so `.pth`, `R_LIBS_SITE`, and `NODE_PATH` keep their meaning.
- Cache preparation that actually takes effect at run time, which it does not today.

**Non-Goals:**

- Per-sandbox farms and concurrent analyses on different closures. One `current` pointer selects one farm. Deferred until the Kubernetes storage-class decision is made.
- The Kubernetes path. The store is a PVC claim there, and a `ReadWriteOnce` claim pins every consuming pod to one node. That is a storage decision, not a code change, and it belongs in its own change.
- The agent-facing install tool and its approval flow.
- Making a new package visible to a sandbox that is already running. A provisioned package is picked up by the next sandbox, not by a live one.
- conda and Node. conda is mounted whole rather than farmed, for reasons below, and Node has one package in the manifest. Both are follow-on work.
- The manifest recipe schema: **retired**, not deferred. Phase 1 chose the pak lockfile as the recipe, so no schema is built.

## Decisions

**Put the store and the farms under the one existing bind.** The alternative was a second mount for the store, which would have touched `MountPlanStores`, `MountPlan`, `buildMountPlan`, `DockerClientConfig`, the `binds` array, and the Kubernetes volume builder. It is unnecessary. `libStoreUsable` (`src/sandbox/docker-client.ts:126`) requires only that `current/` resolve to a directory holding `packages.txt` and `meta.json`, and `libStorePath` is bound whole. Placing `store/` and `farms/` beneath that root means farm links can target `/mnt/libs/store/…`, a path that exists in the provisioner and the sandbox alike, and the harness needs no change at all. That is what let the prototype be validated before any product code was written.

**Content-address the installed result, not the source artifact.** A wheel can have several distributions per version, and choosing among their hashes is ambiguous. Hashing the tree that the install actually produced is unambiguous, and it is what the sandbox will load. Derived data — `__pycache__`, `.pyc`, `.nbi`, `.nbc` — is excluded from the address, so cache preparation does not invalidate it. The trade-off is real and must be closed separately: a content address detects corruption but does not prevent a substituted upstream file. `uv pip compile --generate-hashes` supplies the missing half and is part of this change.

**Use a symlink farm, not a long search path.** For Python there is no choice, because `site-packages` is one directory. For R there is: `R_LIBS_SITE` takes a list. Measured, 205 real library paths cost 0.70 s for 20 `library()` calls against 0.36 s for a single farm path. At the manifest's 168 R packages the farm wins, and it keeps one design across languages.

**Link whole top-level entries, not individual files.** This is what keeps `$ORIGIN`-relative RPATHs working. `dlopen` resolves `$ORIGIN` from the real path of the shared object, so a wheel's `scipy/` and its vendored `scipy.libs/` must come from the same store directory. Linking per entry guarantees that; linking per file would break every auditwheel-repaired wheel. Where two distributions share a top-level name — a namespace package — the shared prefix is promoted to a real directory and both sides are linked beneath it. Measured: 0 collisions across a 50-distribution closure.

**Prepare caches to `NUMBA_CACHE_DIR`, and seed them into a writable path at start.** numba chooses a cache locator by writing a probe file, so a read-only directory is skipped for reads as well as writes. Measured three ways: the in-tree cache in `sandbox-python` today yields 0 loads and 24 recompiles; a read-only `NUMBA_CACHE_DIR` yields 30 saves and 0 loads; a seeded writable one yields 29 loads and 0 saves. The seeding costs a few hundred kilobytes of copy and belongs in `sandbox-entrypoint.sh`, which already runs before the workload in every transport mode.

**Prepare the cache through `/mnt/libs/current`, and by executing code.** Two constraints, both measured, both easy to get wrong. numba's cache key contains the source file path, so preparing through `/mnt/libs/farms/<name>/…` yields 0 loads and 29 recompiles while preparing through `current` yields 29 loads and 0. And numba compiles at first call, not at import: importing numba, matplotlib and scanpy produced 0 cache entries, while a real workload produced 23. The provisioner therefore flips `current` before preparing, and takes a workload script rather than a module list.

**Do not farm conda.** conda binaries carry their build prefix compiled in. The prefix is bind-mounted whole at the exact path that built it. The farm holds an empty `conda/` only as the mount point.

**Farm R the same way as Python; install it with pak.** R is the easiest of the three languages, not the hardest: measured, an installed R package contains no reference to its install path in any file, text or binary, and its compiled objects carry no `RPATH` or `RUNPATH`. `library()` loads through a symbolic link and `Rcpp::evalCpp` works. R also accepts a list of library paths, so a farm is not strictly required — but at the manifest's 168 R packages a 205-entry search path costs 0.70 s per 20 `library()` calls against 0.36 s for one farm path, so the farm wins and keeps one design across languages. The install mechanism is pak, not r2u: `images/gen-r-lock.R` resolves the CRAN + Bioconductor + git track into one pak lockfile, installs it, and splits the result into `r/cran` and `r/bioconductor` by the CRAN-ref dependency closure — pak also installs each package's system libraries from its `SystemRequirements`. The GitHub set stays incremental, installed on top. Because an R library holds one directory per package, the provisioner content-addresses each directory the split produces, reading name and version from each `DESCRIPTION`, exactly as it does a Python distribution. The lock feeds both roles: the baked image reads it now, the provisioner reads it here.

**Publish the store to GHCR as an OCI artifact, through ORAS. [decided 2026-08-05]** The store is not an image, but GHCR accepts a non-image OCI artifact through an ORAS push. Homebrew serves every binary bottle from ghcr.io this way, anonymously and at large scale. The build publishes one artifact for each architecture, with one layer for each track. The registry limit is about 10 GB for each layer, and a compressed track stays far under it.

Three reasons decide it. The OCI digest is a sha256, thus the integrity model matches the content-addressed store. An anonymous pull of a public package works without an account. And one host then serves the sandbox image and the store, on one CDN domain, thus one egress domain is the whole allowlist. S3 stays only for the managed mount, until the managed delivery design replaces it — the managed service is decoupled and constrains nothing here. The consumer half — the CLI pull, the receipt, and the gate that holds sandbox creation until the store is complete — belongs to the CLI side.

**Re-point `current` only when no sandbox is using it.** Measured on podman/macOS: replacing the `current` symlink while a container has the store mounted breaks that container's view of `/mnt/libs/current`, which raises `FileNotFoundError` from then on rather than resolving to either farm. Provisioning is therefore an operation between sandboxes, and the provisioner must not swing the pointer under a live one.

**Publish by rename inside the store.** A rename is atomic only within one filesystem, and the store is a bind mount, so staging under `/tmp` fails with `EXDEV` — this was hit in the prototype. Staging lives at `store/.staging/`, and the publish is a rename within the store. This follows the pattern `cli/src/modules/refs/store.ts` already uses for reference data: stage, rename, then write the receipt, so a crash reads back as incomplete and the next run repairs it.

## Risks / Trade-offs

- **The provisioner has a network and a compiler** → It mounts the store and nothing else, so it holds no user data. Its egress is restricted to the package indexes. It is short-lived and is never the container that runs analysis code.
- **A substituted upstream package** → `--generate-hashes` pins the source, the content address pins the result, and the lock file records both. All three are required; the prototype has only the third.
- **The store grows without bound** → No store in this repository has any cleanup today. This change adds a command that removes a store directory no farm references. It does not add automatic collection, because a package no current farm uses is still needed to repeat an old analysis.
- **Two provisioners at once** → Content addressing makes the package writes safe. The `current` pointer has no such protection, so a per-store lock is required. Note the reference-data installer has the same gap, so this is not a new class of problem.
- **Cache preparation silently stops working** → It already has, unnoticed, in the shipped image. The acceptance check counts cache loads against saves; a save at run time fails the build.
- **macOS development gets slower** → Measured 2.73 s against 1.18 s for the same farm on the container filesystem. The cost is virtiofs on the bind mount, not the design; Linux bind mounts do not use it. Developers on macOS will notice; production will not. This must be re-measured on Linux before the number is accepted.
- **`packages.txt` says installation is impossible** → Its header, the tool description, and the standards prompt all become inaccurate the moment the store is writable by a host action. All three are corrected here, before the tool that performs an install exists.

## Migration Plan

The store is additive. `libStorePath` is unset today, so nothing regresses while it stays unset.

1. Land the provisioner and the store format. Nothing consumes them yet.
2. Verify a store against the baked image: build the same package set both ways and require the versions and import results to agree. A self-consistent test cannot catch a store that is wrong in the same way twice.
3. The CLI change sets `libStorePath` behind a config value that defaults off.
4. Rollback is unsetting that value. The baked image still works and is unchanged by this change.

The baked image and the store can coexist indefinitely, and probably should: baking a base set gives a fast cold start, while the store carries user additions.

## Open Questions

- Does the store replace the baked image, or add to it? Decided (2026-08-05): the store adds to the image. The roadmap records it, and the baked path stays as the fallback.
- Which storage class does the managed service use? It decides whether many pods can share one store, and it gates the Kubernetes change. It does not gate this change or the CLI channel (decoupled, 2026-08-05).
- How long does a store keep a package that no current farm references?
- Should the lock file be part of the provenance record for the analysis? It is the only artifact that makes the environment reproducible after the fact.
