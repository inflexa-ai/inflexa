## Why

The lib-store build we ported from cortex produces **one combined store, amd64-only**, with a `packages.txt` templated from the manifest *wishlist*. Two problems follow:

- **The advertised set lies.** `packages.txt` lists what we *asked* to install, not what actually installed and loads. Load failures escape the build because the checks are uneven — CRAN is existence-checked (`ls | wc -l > 0`), GitHub is log-grepped, and only Bioconductor top-levels get a real `library()`. A broken CRAN/GitHub binding passes CI and surfaces later at runtime, where the planner has already written sandbox code against a package that can't load.
- **No bundle/arch story.** The handoff locks a target matrix — a Python+conda bundle on amd64 **and** arm64, and a Python+R+conda bundle on amd64 (arm64 R deferred). The current pipeline delivers neither the split nor arm64.

This change restructures the store as **per-track, content-addressed, immutable artifacts** selected into named bundles at download time, and introduces **two fail-loud validation gates** so the advertised set is provably the loadable set on a real user's machine.

## What Changes

- **Packaging unit ≠ selection unit.** Ship one tarball **per track** (`cran`, `bioconductor`, `github`, `python`, `conda`, `node`), each carrying its own `packages.txt` fragment. A **bundle** is a named set of tracks chosen at download time — `python-conda` = `{python, conda, node}`, `python-r-conda` = that plus the R triple (`cran`+`bioconductor`+`github`, which travel as a unit because they share one `.libPaths()`). arm64 simply has no R tarballs, which makes "arm64 R deferred" fall out for free.
- **Immutable + manifest.** Each build publishes to a write-once `<version>/linux-<arch>/<track>.tar.zst`. A per-bundle-per-arch **manifest** (lockfile) pins each track's tarball digest. `latest/<bundle>/<arch>` is the one mutable pointer and it advances **only to a validated version**.
- **`packages.txt` derives from the verified-loadable set.** The build-time load test (Gate 1) generates each track's `packages.txt` fragment from what actually loaded, not the manifest. The CLI concatenates the pulled fragments into the single `/mnt/libs/current/packages.txt` the harness already reads — no runtime-contract change.
- **Two fail-loud gates in different worlds.** Gate 1 (build-time, cheap): `import`/`library()` each package in the builder; fail the build on a gross load failure. Gate 2 (after-build, extensive): a separate action pulls the published store **as a user would**, on a **fresh machine** (read-only mount, no network, no `-dev` headers), mounts it in `sandbox-base`, and runs the full suite; green promotes `latest`, red blocks promotion.
- **Per-ecosystem layered validation.** `import`/`library()`/`require()` for *every* package (auto, catches the escaping binding/`.so` class); a small curated real-op for the ~6–10 **compiled anchors** (DESeq2, scran, scanpy/numba, samtools, …); and — for R only, where packages ship their own examples — a deeper `tools::testInstalledPackage` pass (network-filtered).
- **Shared pull handler.** The validator invokes the real `inflexa libs pull <bundle>` CLI handler; the interactive setup flow reuses the same handler (one dogfooded code path). *(cli subsystem — its own cli/openspec change; tracked here as a dependency.)*

## Capabilities

### New Capabilities
- `lib-store-build`: the contract for how the library store is built, validated, and published — per-track content-addressed tarballs, named bundles as track-sets, the immutable-version + manifest + validated-`latest` model, `packages.txt`-from-verified-loadable, and the two fail-loud gates. Owns the invariant *the advertised set equals the loadable set, proven on a fresh machine before `latest` moves*. Colocated with the `lib-store` runtime contract it feeds.

### Modified Capabilities
- None. The `lib-store` runtime mount contract is unchanged: the store is still a read-only mount at `/mnt/libs/current` with a single `packages.txt` and the same resolver env. Per-track fragments are concatenated by the CLI at extract time, below the harness contract.

## Impact

- **Build** (`.github/workflows/lib-store.yml`, `images/lib-store-builder/Dockerfile`, `scripts/build-libs-local.sh`): per-track tarballs + per-track `packages.txt` from the Gate-1 load set; parametrize the `packages-txt` stage per track; arch matrix (full on the self-hosted amd64 runner, which also emits the core tracks; core on a free arm64 runner).
- **Publish**: immutable `<version>/…` layout + per-bundle-per-arch manifest; `latest` promotion moved behind Gate 2.
- **Validate** (new `.github/workflows/validate-lib-store.yml` + suite under `scripts/`): black-box pull → mount in `sandbox-base` → import-all + anchors + R examples → fail loud → promote + standard GitHub Actions badge (no S3 status JSON, no nightly for now).
- **CLI** (`cli/`, separate change): `inflexa libs pull <bundle>` — resolve manifest, dedup-pull tracks by digest, extract, concat `packages.txt`. Reused by the validator and the setup flow.
- **Spec**: new `lib-store-build` capability under `harness/openspec/specs/`; the existing `lib-store` spec is untouched.
- **Deferred**: Python+R+conda on arm64 (r2u is amd64-only; bioconda aarch64 is patchy). Per-track *versioning* (a track advancing independently of others) — v1 treats a version as one coherent build; the manifest leaves room to grow into it.
