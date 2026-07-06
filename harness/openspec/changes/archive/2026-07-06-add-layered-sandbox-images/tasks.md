# Tasks

## 1. Images — layered topology

- [x] 1.1 Keep `images/sandbox-base/Dockerfile` analysis-package-free; confirm `/mnt/libs/current` is empty and it stays the managed runtime.
- [x] 1.2 New `images/sandbox-python/Dockerfile` (`FROM sandbox-base`): install Python libs → `/mnt/libs/current/python/site-packages`, bioconda CLI tools → `/mnt/libs/current/conda`, Node packages → `/mnt/libs/current/node`. Port the install logic from `lib-store-builder`'s `python`/`system-tools`/`node` stages.
- [x] 1.3 New `images/sandbox-python-r/Dockerfile` (`FROM sandbox-python`): install R libs → `/mnt/libs/current/r/{cran,bioconductor,github}`. Port the `cran`/`bioconductor`/`github` stage logic, incl. the arm64 source-install fallback.
- [x] 1.4 Bake the resolver env (`R_LIBS_SITE`, `NODE_PATH`, `PATH`+conda `bin`, keep the Python `.pth`) into the images so they resolve with no mount and no harness.
- [x] 1.5 Bake `/mnt/libs/current/packages.txt` (concatenation of the present tracks' fragments) into each image.
- [x] 1.6 Add `INFLEXA_LIB_ROOT` + `PIP_TARGET` / `R_LIBS_USER` / npm prefix so `FROM`-extension installs land in the store; add the `inflexa-libs-refresh` helper that re-derives `packages.txt`.
- [x] 1.7 Retire the `lib-store-builder` Dockerfile; keep `lib-store-manifest.yaml` as the package-set source of truth consumed by the image builds.

## 2. Verification — load check / coverage / acceptance

- [x] 2.1 Make the load check best-effort: a single package's load failure drops it from the fragment instead of failing the track (update `lib-store-loadtest.R`, `lib-store-py-loadtest.py`, and the conda/node checks).
- [x] 2.2 Enforce the non-empty floor: a track with zero loaded packages fails the build.
- [x] 2.3 Add the coverage-report step: per arch × track want/loaded/missing table + diff against the last published manifest; amd64 regression = fail, arm64 missing = informational.
- [x] 2.4 Rename off numbered gates: `lib-store-gate2.sh` → `lib-store-acceptance.sh`; strip "Gate 1/Gate 2" from Dockerfile comments, `validate-lib-store.yml`, scripts, README, and spec prose.
- [x] 2.5 Extend acceptance to optionally boot each published image directly (baked, no mount) and run the suite, in addition to the pull-as-user mount path.

## 3. Build / publish pipeline

- [x] 3.1 Update `.github/workflows/lib-store.yml` to build + push the three images per arch to `ghcr.io/inflexa-ai/inf-cli/*` as multi-arch manifests (auth via the workflow `GITHUB_TOKEN`, `packages: write`).
- [x] 3.2 Extract per-track tarballs from the published images (tar each `/mnt/libs/current/<track>` subtree), hash, and publish the per-arch manifest + immutable-version layout unchanged.
- [x] 3.3 Update `scripts/build-libs-local.sh` and the `lib-store-*` scripts to source tarballs from the images rather than a builder staging tree.
- [x] 3.4 Confirm dedup-by-digest and write-once versioning still hold end to end.

## 3b. Cleanup pass (scripts + Dockerfiles + workflows)

- [x] 3b.1 Delete `images/lib-store-builder/Dockerfile`; move its per-track install logic into the three runtime Dockerfiles.
- [x] 3b.2 Retire the client-side local-assembly scripts orphaned by the image path (`lib-store-assemble.sh`, `build-libs-local.sh` assembly, the `smoke-test-libs.sh` wrapper) — keep only what the managed tarball extract + publish still needs.
- [x] 3b.3 Sweep `images/*/Dockerfile`, `scripts/lib-store-*`, and both workflows for dead references to the builder, "Gate 1/Gate 2", staging trees, and any bundle-era leftovers; remove them.
- [x] 3b.4 Verify no script or workflow references a deleted path (grep for `lib-store-builder`, `Gate 1`, `Gate 2`, `assemble`, `staging`).

## 4. Docs

- [x] 4.1 Rewrite `images/sandbox-base/README.md` + add `images/sandbox-python/README.md` and `images/sandbox-python-r/README.md`: the layered-image story, `FROM`-extension, and the `INFLEXA_LIB_ROOT` install convention.
- [x] 4.2 Update the CLI setup docs to present `inflexa sandbox pull <variant>` as the one-step local path (the managed mount path is infra-only, not a user command). Done in the companion cli change (`cli/README.md` "Sandbox image" section).

## 5. Validation of the change

- [x] 5.1 `openspec validate add-layered-sandbox-images --strict` passes.
- [x] 5.2 Confirm the harness `lib-store` runtime contract is genuinely untouched (no spec delta needed there); the cli `lib-store-provisioning` change is captured in the **companion `cli/openspec` change** (`switch-cli-to-sandbox-images`), tracked here as a dependency.
