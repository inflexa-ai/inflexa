# Spike harvest: the build side

This document reports facts for the design review of PR #291. The scope is
`images/`, `scripts/`, `.github/`, `droast.toml`, and `.store-build-trigger`.
A reference with the prefix `spike:` points into the worktree of PR #291
(`origin/feat/two-container-package-store`). A reference with no prefix points
into main today. The document reports what the code does. It gives no judgment.

## 1. Images

### Main today

Main builds three layered images:

- `sandbox-base` (`images/sandbox-base/Dockerfile`). Base: `rocker/r-ver:4.6.0`
  with a digest pin (`images/sandbox-base/Dockerfile:14`). Build args:
  `BASE_IMAGE` (14), `TARGETARCH` (137), `CHROMIUM_PPA_FINGERPRINT` (212).
  Baked env: `UV_VERSION`, `RUFF_VERSION` (120-121), `TAILWINDCSS_VERSION`
  (135), `BROWSER_PATH=/usr/bin/chromium` (229), `HOME=/home/sandbox` (263).
  It carries chromium from the xtradeb PPA (213-223), the `.pth` file for the
  store (239), the Go `sandbox-server` (267), and the provenance hooks (276-278).
  Entrypoint: `sandbox-entrypoint.sh` (289). If `SANDBOX_EGRESS_FIREWALL=1`, the
  entrypoint installs an egress-deny firewall, then drops to uid 1000 with
  `setpriv`, then execs `sandbox-server` (`images/sandbox-base/sandbox-entrypoint.sh:16-38`).
- `sandbox-python` (`images/sandbox-python/Dockerfile`). Build args:
  `SANDBOX_BASE_IMAGE` (23), `BASE_IMAGE` (28), `INFLEXA_LIB_ROOT=/mnt/libs/current`
  (31), `TARGETARCH` (34), `UV_VERSION` (60), `PYYAML_VERSION` (65). Builder
  stages install the pip, conda, and node manifest tracks into the store path
  (78-165, 281-301, 325-340). Each track runs a load check with a non-empty
  floor. A build step imports numba, matplotlib, scanpy, seaborn, pertpy,
  scvi, and cell2location to warm the caches (204-219). The runtime stage bakes
  `NUMBA_CPU_NAME=generic` on arm64 (355-358), the resolver env (415-426), the
  FROM-extension env (423-426), and a real kaleido render check (436-449).
  `CMD ["sandbox-server"]` (454).
- `sandbox-python-r` (`images/sandbox-python-r/Dockerfile`). Build args:
  `SANDBOX_PYTHON_IMAGE` (26), `BASE_IMAGE` (31), `INFLEXA_LIB_ROOT` (32),
  `R_NCPUS` (37). A BuildKit secret `github_token` feeds `GITHUB_PAT` (264-272).
  CRAN installs with r2u on amd64 and with the P3M snapshot on arm64 (119-131).
  The runtime stage copies each R track in one layer each (344-349).

### Spike HEAD

The spike deletes `sandbox-python` and `sandbox-python-r`. Two images remain:

- `sandbox-base`, the one runtime image (`spike:images/sandbox-base/Dockerfile:1-18`).
  It bakes no R library and no Python library (417-420). New stages:
  `libs-toolchain` (54), `conda-builder` into `/opt/conda` (77-98),
  `node-builder` into `/opt/node` (155-172). Build args: `BASE_IMAGE` (23),
  `TARGETARCH` (26), `CHROMIUM_PPA_FINGERPRINT` (385). New content against main:
  - `libglu1-mesa` for rgl (236-240), and `ENV RGL_USE_NULL=TRUE` (275)
  - the empty store mount point (420)
  - the baked resolver env: `INFLEXA_LIB_ROOT`, `R_LIBS_SITE`,
    `NODE_PATH=/opt/node/node_modules`, and `PATH` with `/opt/conda/bin` last
    (433-436)
  - the image inventory at `/opt/inflexa/{conda,node,image-packages}.txt` (460-464)
  - the seed file `inflexa-seed-caches` (504)

  The arm64 arch stage sets `NUMBA_CPU_NAME=generic` (533-536). The entrypoint
  sources `inflexa-seed-caches` and calls `seed_caches` before the firewall path
  and before the exec (`spike:images/sandbox-base/sandbox-entrypoint.sh:23-58`).
- `sandbox-provisioner` (`spike:images/sandbox-provisioner/Dockerfile`). It has
  network and compilers, and it mounts only the store (1-6). Build arg:
  `BASE_IMAGE`, and a RUN asserts that it equals the manifest `base_image`
  (17-36). It installs the shared toolchain plus `python3-yaml`,
  `python3-packaging`, and the jags/libuv/libprotobuf/libglpk set (47-48), uv
  0.7.12 (52-54), and pak plus yaml for R (60-61). It copies `gen-r-lock.R`
  (62), `inflexa-libs-refresh` (67), `provision.py` as `/usr/local/bin/provision`
  (68), `emit_deps.py` (73), and `base-packages.json` (74).
  `ENTRYPOINT ["/usr/local/bin/provision"]` (83).

Flags of `provision` (`spike:images/sandbox-provisioner/provision.py:1711-1739`):
positional specs, `--farm`, `--r-manifest`, `--warm`, `--warm-script`,
`--verify`, `--repair`, `--reclaim`, `--add-lease ID`, `--drop-lease ID`,
`--remove-farm NAME`. Env: `LIB_ROOT` (86), `SANDBOX_LIB_MOUNT` (93),
`INFLEXA_INDEX_URL` (128), `R_NCPUS` (`spike:images/gen-r-lock.R:23`), and
`GITHUB_PAT` for the R GitHub track
(`spike:.github/workflows/lib-store-provisioner.yml:268-269`).

## 2. The manifest

### Main today

`images/lib-store-manifest.yaml` holds `r_version`, `python_version`, and a
digest-pinned `base_image` (2-8). Tracks: `r.cran` (11), `r.bioconductor`
(159), `r.github` (315), `python.pip.common` plus `python.pip.amd64` and
`python.pip.arm64` (363-573), `node` (577), and `system_tools` with `common`,
`amd64`, and a `binaries` map (593-637). A pin lives inside a spec string, for
example `"jax<0.10"` (371), `samtools=1.22.1` (613), and
`stuart-lab/signac@1.16.0` (339). No entry pins a commit. No `warm` key exists.
Rationale travels as comments, not as structured fields.

### Spike HEAD

The skeleton stays (`spike:images/lib-store-manifest.yaml:2-8, 10, 163, 318,
381-592, 621, 638-682`). Changes:

- `r.cran` adds `pak`, because the provisioner image satisfies pak in its own
  resolve and puts no copy in the pool (`spike:images/lib-store-manifest.yaml:53-57`).
  `CVXR` is gone from the transitive block (main:87 has it, the spike does not).
- A new `r.git` list holds structured entries with `name`, `url`, `commit`, and
  a mandatory `reason`. The one entry pins `DEP` to the commit
  `251eef42dac5d6e648742ab8b79b8322d6218533` of the Bioconductor RELEASE_3_22
  branch (`spike:images/lib-store-manifest.yaml:365-379`). `DEP` left the
  `bioconductor` list.
- A new top-level `warm` key holds `modules` (numba, matplotlib, scanpy,
  seaborn, pertpy, scvi, cell2location) and `script: images/lib-store-warm.py`
  (`spike:images/lib-store-manifest.yaml:604-616`). The comment states that the
  catalog build reads the key and passes `--warm` and `--warm-script` (594-597).
- The `node` and `system_tools` comments now say that the image owns those two
  tracks, at `/opt/node` and `/opt/conda` (`spike:images/lib-store-manifest.yaml:620-632`).
- Per-arch handling is unchanged: `python.pip.amd64/arm64` (588-592) and
  `system_tools.amd64` (667-673). The `r.git` entries are the only structured
  entries. Every other entry is a string with comments.

## 3. Warming

### Main today

No `warm` flag exists. The warm-up is a fixed list inside the `sandbox-python`
image build: one RUN imports seven packages into the store caches
(`images/sandbox-python/Dockerfile:204-219`), and the runtime stage moves the
matplotlib font cache to `/home/sandbox/.cache/matplotlib` and sets
`MPLCONFIGDIR` (390-392). Warming runs at OCI build time only.

### Spike HEAD

The warm path, end to end:

1. The manifest declares the workload: `warm.modules` and `warm.script`
   (`spike:images/lib-store-manifest.yaml:604-616`).
2. One reader exists. The step "Read the workload of the preparation run from
   the manifest" in the provisioner workflow parses `warm.modules` and
   `warm.script` (`spike:.github/workflows/lib-store-provisioner.yml:230-258`).
   A grep of the whole spike tree finds no other reader of the manifest key: not
   the harness source, not the CLI source, only OpenSpec documents and this
   workflow.
3. A first provisioner run builds the `catalog` farm from the pip specs and the
   R manifest (`spike:.github/workflows/lib-store-provisioner.yml:260-301`).
4. A second provisioner run passes `--farm catalog --warm <modules>
   --warm-script /opt/lib-store-warm.py`, with the store bound read-write at
   `/mnt/libs` and the farm bound read-write at `/mnt/libs/current`
   (343-366). A run that builds a farm refuses the warm flags
   (`spike:images/sandbox-provisioner/provision.py:1531-1541`), and
   `prepare_caches` accepts only the catalog farm (1143-1147).
5. `warm()` does these steps, in order:
   - It probes that the bind resolves the farm (1029-1042).
   - It points `MPLCONFIGDIR` and `NUMBA_CACHE_DIR` at
     `farms/catalog/{matplotlib_config, numba-cache}` (1049-1057).
   - On aarch64 it sets `NUMBA_CPU_NAME=generic` (1052-1055).
   - It imports each module, and then it runs the script (1059-1083).
   - It replays the same workload with `NUMBA_DEBUG_CACHE=1`, and it records
     the entries that reload (1089-1097).

   `prepare_caches` writes `warm_script`, `warm_workload` (modules, script
   sha256, cache_entries), and `warm` into the farm `lock.json` (1158-1167).
6. The workload script `spike:images/lib-store-warm.py` runs a scanpy pipeline:
   `calculate_qc_metrics`, `highly_variable_genes` (seurat_v3),
   `normalize_total`, `log1p`, `scale`, `pca`, `neighbors` with pynndescent,
   and `rank_genes_groups` with wilcoxon (86-126). It renders a seaborn heatmap
   into a memory buffer (141-151). It runs `pertpy` `Distance.pairwise` (161).
   It fits scvi and cell2location `RegressionModel`, each for one epoch
   (180-185, 201-204). numba warms through scanpy and pertpy. scvi and
   cell2location prove entry points only (169-179, 196-200). The docstring
   names two sparse kernels that no run can cache (12-19).
7. At analysis runtime, the sandbox entrypoint sources `inflexa-seed-caches`
   and calls `seed_caches`
   (`spike:images/sandbox-base/sandbox-entrypoint.sh:23, 43, 57`). The function
   copies `numba-cache` and `matplotlib_config` from `/mnt/libs/current` to
   `/tmp`, exports `NUMBA_CACHE_DIR` and `MPLCONFIGDIR`, and sets
   `NUMBA_CPU_NAME=generic` on arm64
   (`spike:images/sandbox-base/inflexa-seed-caches:16-37`).
8. The host composer of the CLI links `numba-cache` and `matplotlib_config`
   from the catalog template into each analysis farm
   (`spike:cli/src/modules/libs/composition.ts:92-96, 1125`).
9. The check `spike:scripts/lib-store-cache-check.py` runs inside sandbox-base.
   It confirms the script bytes against the recorded sha256 (160-167). It
   replays the workload, and it fails when a recorded entry writes again or
   does not load (198-215). The workflow runs it against a composed farm and gates the
   artifact on it (`spike:.github/workflows/lib-store-provisioner.yml:368-435`).

Phase: warming runs at provisioning time, in a provisioner container run. It
does not run at OCI build time and not at analysis runtime. The runtime only
copies the prepared caches.

Dead code and contradictions, stated precisely:

- The docstring of `provision.py` states: "An ACQUISITION run with a workload
  prepares what it acquired" (`spike:images/sandbox-provisioner/provision.py:48-51`),
  and the refusal text states: "An acquisition run publishes no farm, thus that
  run warms the distributions that it acquires" (1538-1540). No code does this.
  `_acquire` (1468-1513) never reads `args.warm`, and `main()` routes every
  no-farm run to `_acquire` (1763-1773). A no-farm run with `--warm` drops the
  flag in silence. The documented acquisition-warm shape is dead.
- `spike:scripts/store-prototype/inflexa-store` is stale against `provision.py`.
  Its `add` passes `--warm`/`--warm-script` together with `--farm` and specs
  (60-66), a combination that `provision.py` refuses (1531-1541). Its `use`
  writes a `current` pointer at the store root (76-77), and the store contract
  denies a pointer (`spike:scripts/lib-store-provisioner-checks.sh:216-218`,
  `spike:.github/workflows/lib-store-provisioner.yml:446-460`). Its PROLOGUE
  duplicates `seed_caches` by hand (111-114). Only its `build` subcommand is
  still referenced (`spike:scripts/lib-store-provisioner-checks.sh:42`).
- Every other warm component is invoked: the workflow calls the warm run and
  the cache check, and `spike:scripts/lib-store-sandbox-checks.sh:295-465`
  exercises the same pair locally.

## 4. Store layout on disk

### Main today

The store is one directory at `/mnt/libs/current`
(`scripts/lib-store-common.sh:10-21`). It holds `r/cran`, `r/bioconductor`,
`r/github`, `python/`, `conda/`, `node/`, one `<track>.packages.txt` fragment
per track, `packages.txt`, and `meta.json` (10-15). The image builds write the
subtrees and the fragments. `inflexa-libs-refresh` writes `packages.txt`
(`images/sandbox-python/Dockerfile:394-405`). `lib-store-write-packages.sh` and
`lib-store-write-meta.sh` write the two S3 objects (`scripts/lib-store-publish.sh:120-128`).
S3 also holds `<version>/linux-<arch>/<track>.tar.zst` with `.sha256` and
`.size` sidecars, `manifest.json`, `latest/.../manifest.json`, and
`candidate/linux-<arch>.json` (`scripts/lib-store-publish.sh:80-167`,
`scripts/lib-store-common.sh:116-127`). The harness mounts a store only when
`packages.txt` and `meta.json` are both present (`scripts/lib-store-write-meta.sh:5-9`).

### Spike HEAD

The store root is `/mnt/libs` (`spike:images/sandbox-provisioner/provision.py:86`).
Its contents:

- `store/<name>-<version>-<hash16>/` — one write-once directory per installed
  distribution (7-13, 333-345). Writer: `provision.py`. Reader: each sandbox,
  through farm links. A Python directory holds `.inflexa-pin` at its root
  (132, 340). An R directory nests the package as `<dir>/<Name>/`, with
  `.inflexa-pin` and `.inflexa-r-linking` inside the inner directory (752-775).
  The markers and derived caches stay out of the content address (140-150).
- `farms/<analysis>/` — one symlink farm per analysis (15-20). Contents:
  - `python/site-packages/` — one link per top-level entry into a store
    directory. A real directory appears only for a merged namespace (384-441).
  - `python/bin/` — relative links to hoisted console scripts (497-508).
  - `r/{cran,bioconductor,github}/` — links to the inner R store directories
    (780-801).
  - `r-bulk.lock` — the pak lockfile, provenance of the R track (916-924).
  - `lock.json` — the run record: `requested`, `resolved`, `hashes`,
    `store_dirs`, `r` (with `packages`, `farmed`, `r_version`,
    `bioc_releases`), `tracks` (`built`/`preserved`), `collisions`,
    `warm_script`, `warm_workload`, `warm` (1619-1638, 929-930). Writer:
    `provision.py`. Readers: the R load check
    (`spike:scripts/lib-store-r-load-check.py:93-101`), the cache check
    (`spike:scripts/lib-store-cache-check.py:145-169`), and later runs (1546-1551).
  - `meta.json` — `{version, arch, tracks}`, a completeness marker the harness
    gate requires (1655-1664).
  - `packages.txt` and the per-track fragments, written by
    `inflexa-libs-refresh --rederive` into the staging farm (1647-1653,
    `spike:images/sandbox-base/inflexa-libs-refresh`).
  - `numba-cache/` and `matplotlib_config/` — real directories in the catalog
    farm only. An analysis farm links them into the catalog
    (933-956, `spike:cli/src/modules/libs/composition.ts:92-96`).
- `deps.json` — the dependency graph at the store root, written by a
  temp-file-plus-rename (`spike:images/sandbox-provisioner/emit_deps.py:59-68,
  491-500`).
- `leases/<id>` — one JSON file `{lease, farm}` per live sandbox. The host
  writes it. `remove_farm` refuses while one holds the farm (94-100, 1384-1404,
  1449-1462).
- `.provision.lock` — shared for an acquisition, exclusive for reclaim, repair,
  and removal (1282-1341). `.commit.lock` — the short commit mutex (1345-1354).
- Transient names: `store/.staging-<token>`, `store/.staging-r-<token>`
  (264-274), `farms/.staging-<name>`, `farms/.superseded-<name>` (102-109),
  and `.inflexa-bind-probe-<uuid>` (1030-1035).

The store carries no `current` pointer. Each sandbox receives its farm as a
second read-only bind at `/mnt/libs/current` (26-29). The workflow removes a
stray `current` directory before the export
(`spike:.github/workflows/lib-store-provisioner.yml:446-460`). Acceptance
requires `farms/catalog/packages.txt`, `farms/catalog/meta.json`, and
`deps.json` (`spike:.github/workflows/lib-store-acceptance.yml:177-181`).

## 5. The dependency graph

### Main today

No dependency graph exists on main.

### Spike HEAD

`spike:images/sandbox-provisioner/emit_deps.py` emits it.

- Python fields, from importlib.metadata:
  - the `Name` metadata field (289-299)
  - the `Requires-Dist` lines, through `dist.requires` (302-307)
  - `top_level.txt` for import names, with a filesystem fallback (310-336)
  - entry points in the groups `("console_scripts", "gui_scripts")` (86-88)
- R fields, verbatim: `fields <- c("Depends", "Imports")` — one Rscript call
  reads each DESCRIPTION with `read.dcf` (94-106, 348-382). A version
  constraint in parentheses is stripped to the bare name (376-381). LinkingTo
  gives no edge, because it is a build-time field (26-29, 353-357). Separately,
  `provision.py` records the LinkingTo names of each stored R package into
  `.inflexa-r-linking` (`spike:images/sandbox-provisioner/provision.py:710-737,
  772-775`).
- PEP 508 markers: `packaging.markers.Marker.evaluate` against a fixed
  environment with `extra=""` (126-154). `InvalidMarker` and `InvalidVersion`
  keep the edge and log a warning (163-182).
- Output shape: `deps.json` holds `version: 1` and `nodes`, keyed by the store
  directory name (61-68). A node carries `track`, `name`, `version`, `imports`,
  `entry_points`, `edges`, and `r_dir` for R (406-448). `by_name` orders the
  directories of each name per track, newest first (11-16, 232-246, 546).
- The gate: an edge that names no node stops the build, unless the name is in
  `base-packages.json`, the image-owned list (30-33, 441-447, 503-520). The
  rule text sends a revealed name to the manifest or to `base-packages.json`
  (76-80, `spike:images/sandbox-provisioner/base-packages.json:3`).
- Producers: `_acquire` commits through `append_store_dirs`
  (`spike:images/sandbox-provisioner/provision.py:1509-1510`), and `_provision`
  commits through `append_for_farm` after the swap (1676-1679).
- Consumers: the CLI store modules read it
  (`spike:cli/src/modules/libs/composition.ts`,
  `spike:cli/src/modules/libs/packages.ts`,
  `spike:cli/src/modules/libs/store_download.ts`, `spike:cli/src/lib/lock.ts`),
  the acceptance workflow requires it
  (`spike:.github/workflows/lib-store-acceptance.yml:179`), and the parallel-run
  check reads it (`spike:scripts/lib-store-provisioner-checks.sh:404-408`).

## 6. The OCI bundle

### Main today

No OCI bundle exists. The build publishes baked images to GHCR and per-track
tarballs to S3 (`.github/workflows/lib-store.yml:1-36`,
`scripts/lib-store-publish.sh:1-33`).

### Spike HEAD

The provisioner workflow builds and publishes the bundle:

- A script inside the store volume assigns each store directory to one track,
  from the farm links (`spike:.github/workflows/lib-store-provisioner.yml:507-587`).
  The first track in canonical order owns a shared directory. The base layer
  holds the farms, every other root entry, and each unreferenced store
  directory (573-581).
- Each layer is a tar with sorted names and verbatim symlinks, compressed with
  zstd level 3 (592-603). Media types:
  `application/vnd.inflexa.lib-store.track.v1.tar+zstd`,
  `application/vnd.inflexa.lib-store.base.v1.tar+zstd`, artifact type
  `application/vnd.inflexa.lib-store.manifest.v1+json` (613-616).
- ORAS pushes to `ghcr.io/<owner>/lib-store:<version>-<arch>` (658-661). The
  version tag is immutable: the step fetches the remote manifest, compares the
  layer digests, skips an identical publish, and refuses a different one
  (605-649). Only a push moves the `latest-<arch>` tag (663-668).
- Arch variants: the matrix runs amd64 as the primary leg and arm64 as a
  best-effort leg with `continue-on-error` (102-124). The store also uploads as
  a symlink-preserving CI artifact `lib-store-content-addressed-<arch>`
  (462-486). ORAS itself installs pinned by version and per-arch sha256 (168-187).
- Validation against the sandbox image: the workflow builds sandbox-base from
  the same commit (207-228). It runs the R load check inside that image
  (321-341). It runs the cache check inside that image, against a composed farm
  (368-435). Both gate the artifact (19-24). Acceptance then pulls the
  published artifact and extracts each layer. It confirms the completeness
  markers, mounts the store read-only into the published sandbox-base, and
  runs the suite (`spike:.github/workflows/lib-store-acceptance.yml:152-195`).
  In farm mode
  the suite also confirms that each advertised Python module resolves from the
  content store (`spike:scripts/lib-store-validate/validate.py`, `--farm` and
  `_loaded_from_store`). The workflow states that a store-against-image
  equality check is out of scope (`spike:.github/workflows/lib-store-provisioner.yml:27-30`).

## 7. CI

### Main today

- `.github/workflows/lib-store.yml` (dispatch only) does these steps:
  - It builds and pushes the three images per arch on self-hosted builders (146-189).
  - It stamps the inventory label (168, 188).
  - It extracts the tarballs from the top image (194-205).
  - It runs the coverage report, with an amd64 regression gate (218-234).
  - It packs and publishes the tracks to S3 through
    `scripts/lib-store-publish.sh` (258-279).
  - It uploads a candidate artifact (293-306), and it combines multi-arch
    manifests (318-354).
- `.github/workflows/lib-store-acceptance.yml`: runs after a green build or on
  dispatch, pulls the published `sandbox-python-r` or `sandbox-python`, boots
  the baked image, and runs the suite. It is non-gating (1-139).
- `.github/dependabot.yml` tracks the docker files of all three image
  directories (49-54). `droast.toml` overrides cover the three Dockerfiles
  (3-9). `.store-build-trigger` does not exist.

### Spike HEAD

- `spike:.github/workflows/lib-store.yml`: builds and pushes only
  `sandbox-base` (124-143) and `sandbox-provisioner` (177-188), from the one
  manifest base digest (11-14). No inventory label, no tarball extraction, no
  coverage step, and no S3 publish (118-122, 145-148). The candidate artifact
  records the sandbox-base tag (149-162). The manifest job combines both images
  (218-240).
- `spike:.github/workflows/lib-store-provisioner.yml` (new, 680 lines) does
  these steps:
  - It builds the provisioner and sandbox-base locally (189-228).
  - It reads the warm workload from the manifest (230-258).
  - It emits the store into a docker volume (260-301).
  - It runs the R load check (321-341).
  - It prepares the caches (343-366), and then it runs the cache check
    against a composed farm (368-444).
  - It removes the stray `current` mount point (446-460).
  - It exports the tar artifact (462-486), packs the OCI layers, and
    publishes with ORAS (488-670).

  Triggers: `workflow_dispatch` with
  an `r_ncpus` input, plus a temporary `push` trigger on the feature branch for
  the path `.store-build-trigger` (50-64).
- `spike:.store-build-trigger`: a sentinel file. A touch of it starts the store
  build on the feature branch. The file says to remove it with the trigger
  before the merge (1-5). It carries `run: 2`.
- `spike:.github/workflows/lib-store-acceptance.yml`: pulls the store artifact
  with ORAS and mounts it into the pulled sandbox-base, as section 6 reports.
  A second dispatch input `store_version` selects the store (38-41).
- `spike:.github/dependabot.yml` drops the two variant docker directories.
  `spike:droast.toml` overrides now name only the sandbox-base Dockerfile (3-19).
- Dormant scripts at the spike: `spike:scripts/lib-store-publish.sh:1-9` says
  "RETIRED" and "No workflow calls this script". Its remainder writes the
  manifest and advances `latest`, dormant. `spike:scripts/lib-store-pack.sh`
  has no caller — the provisioner workflow names it only as a compression
  convention (154, 591). `spike:scripts/lib-store-write-manifest.sh` is called
  only by the retired publish script. `spike:images/README.md:126-127` still
  says that `build-libs-local.sh` "can also extract the per-track tarballs",
  but the spike script only builds sandbox-base
  (`spike:scripts/build-libs-local.sh:1-13, 47-57`).
