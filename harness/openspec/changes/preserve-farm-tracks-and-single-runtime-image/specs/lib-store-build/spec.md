## RENAMED Requirements

- FROM: `### Requirement: The build publishes three layered sandbox images`
- TO: `### Requirement: The build publishes one sandbox runtime image`

## MODIFIED Requirements

### Requirement: The build publishes one sandbox runtime image

The build SHALL publish exactly one runtime image, `sandbox-base`. That image
SHALL carry the language interpreters (R, Python, and Node.js), the system
libraries, `sandbox-server`, and the provenance hooks. It SHALL also carry each
track that a package farm cannot carry: the conda prefix with the bioconda
command-line tools, and the Node packages. It SHALL contain **no** R library and
**no** Python library. Its `/mnt/libs/current` SHALL be empty, so the mounted
package store is the one source of a library. The build SHALL NOT publish a
variant image that bakes a library set: `sandbox-python` and `sandbox-python-r`
are retired.

The image, and never the store, SHALL supply each interpreter. R comes from the
digest-pinned base image the manifest names as `base_image`, and Python and
Node.js come from apt in that same image. A package store SHALL NOT carry an
interpreter, thus a store SHALL NOT change the R version, the Python version, or
the Node version.

The image SHALL place the conda prefix and the Node packages **outside** the store
mount path. A package store mounts read-only over `/mnt/libs`, thus it shadows
each path the image bakes below `/mnt/libs`. The conda prefix SHALL be at
`/opt/conda` and the Node packages SHALL be at `/opt/node`.

The build SHALL **make** the conda prefix at that final path. Conda writes the
absolute prefix path into each shebang and each RPATH. Thus the build SHALL NOT
build the prefix elsewhere and then copy, link, or move it. The prefix SHALL carry
the bioconda tool set, the channel list, and the strict channel priority the
retired conda-builder stage used. It SHALL keep that stage's non-empty-tool floor.

The image SHALL be published for both `linux/amd64` and `linux/arm64` to GitHub
Packages (GHCR) on the `inflexa-ai/inflexa` repository
(`ghcr.io/inflexa-ai/sandbox-base`), as a multi-arch manifest. It SHALL have a
committed Dockerfile that a user can edit or `FROM`.

#### Scenario: One runtime image is published

- **WHEN** the build publishes its runtime images
- **THEN** it publishes `sandbox-base` and no other runtime image, and neither `sandbox-python` nor `sandbox-python-r` is built or pushed

#### Scenario: The runtime image carries no library

- **WHEN** `sandbox-base` is inspected
- **THEN** it contains the runtimes, system libraries, `sandbox-server`, and provenance hooks but no R library and no Python library, and its `/mnt/libs/current` is empty

#### Scenario: The runtime image carries the conda tools and the Node packages

- **WHEN** `sandbox-base` is inspected
- **THEN** the bioconda command-line tools resolve from `/opt/conda/bin` and the Node packages are at `/opt/node/node_modules`

#### Scenario: A mounted store does not shadow the baked tracks

- **GIVEN** `sandbox-base` with a package store mounted read-only at `/mnt/libs`
- **WHEN** a script runs a bioconda command-line tool or requires a baked Node package
- **THEN** both resolve, because neither path is below `/mnt/libs`

#### Scenario: The conda prefix is built at its final path

- **WHEN** the build assembles the conda prefix
- **THEN** it creates the prefix at `/opt/conda` directly, and it never copies, links, or moves a prefix built at another path

#### Scenario: Both architectures are published

- **WHEN** the build publishes the image
- **THEN** `sandbox-base` is published for `linux/amd64` and `linux/arm64`

### Requirement: Sandbox images are self-sufficient at runtime

The published runtime image SHALL bake the package-resolver env and the mount
points the store expects. The env is `R_LIBS_SITE` over the
github/bioconductor/cran subtrees, the Python `.pth`, and `INFLEXA_LIB_ROOT`.
Thus the image with a mounted store and **no** harness resolves imports and
answers `list_available_packages`. The baked env and the harness-injected env name
the same paths, thus the baked env SHALL be safe under the managed mount
(redundant with, never in conflict with, the harness-injected env).

The env for the two image-owned tracks SHALL name their baked paths, not a path
under the store mount. `PATH` SHALL carry `/opt/conda/bin` and `NODE_PATH` SHALL
be `/opt/node/node_modules`. The harness-injected env SHALL name the same two
paths, so a mounted store never removes the tools of the image.

The image SHALL carry the shared `packages.txt` producer, so a store assembled by
any route reports its inventory in one shape. The image SHALL NOT bake a
`/mnt/libs/current/packages.txt`, because `/mnt/libs/current` is empty.

The image SHALL bake an inventory fragment that lists the two image-owned tracks:
the bioconda command-line tools and the Node packages. The build SHALL derive the
fragment from the sets the load check resolved, thus the record matches what the
image installed and it cannot drift. The fragment SHALL live at a path outside the
store mount, so a mounted store never shadows it. Thus the image advertises its own
two tracks, and `list_available_packages` merges the fragment with the farm
inventory.

#### Scenario: The image advertises its two owned tracks

- **WHEN** the baked inventory fragment is read inside `sandbox-base`
- **THEN** it lists the bioconda command-line tools and the Node packages, at a path outside `/mnt/libs`, so a mounted store does not shadow it

#### Scenario: A plain container run resolves a mounted store

- **GIVEN** `sandbox-base` run directly with a package store mounted at `/mnt/libs` and no harness
- **WHEN** a script imports a stored Python package or `library()`s a stored R package
- **THEN** it resolves against `/mnt/libs/current` through the image's baked env

#### Scenario: The baked env names the two image-owned paths

- **WHEN** `sandbox-base` is inspected
- **THEN** its `PATH` carries `/opt/conda/bin`, its `NODE_PATH` is `/opt/node/node_modules`, and neither names a path under `/mnt/libs`

#### Scenario: The image bakes no store inventory

- **WHEN** `list_available_packages` reads `/mnt/libs/current/packages.txt` inside the image with no mount
- **THEN** the file is absent, and the tool reports the store as unavailable rather than throwing

### Requirement: Acceptance is a non-gating post-publish validation

After a build publishes, an **acceptance** run SHALL validate the published store
on a **fresh machine** — no network, runtime environment only, correct
architecture — obtaining the store the way it is actually consumed. Two routes
serve: **the published store artifact, mounted read-only into the published
runtime image** (the user path), and **the extracted tarballs, mounted read-only**
(the managed path). Acceptance SHALL NOT use a validator-private download. It
SHALL run, inside the obtained store:

1. **the import-all invariant** — `import`/`library()`/`require()` for **every**
   advertised package, and a check that the advertised `packages.txt` equals the
   actually-loadable set (advertised ⊆ loadable).
2. **the per-library smoke-test suite** (`lib-validator/run_all.py`) — the
   behavioral pass: each covered library's self-contained smoke test runs a real
   operation and reports pass, not-installed, or fail. An installed-but-broken
   library counts as a failure; an absent library (its not-installed guard fires)
   is a skip.

Acceptance SHALL NOT run R packages' own examples and SHALL NOT maintain a
curated anchor-operation registry; the per-library smoke-test suite is the sole
behavioral pass and covers both R and Python. Acceptance SHALL NOT move `latest`
or any other consumer-facing pointer and SHALL NOT publish, tag, or mutate any
image, store artifact, or tarball — the build already published everything before
acceptance runs. Acceptance SHALL surface, per architecture, a **results table**
in its run summary reporting the import-all tally per track and the per-library
validator outcome (counts of pass / fail / error / skipped, and the
failing/errored libraries), plus an overall green/red status, so a maintainer can
review exactly what was verified.

#### Scenario: Acceptance obtains the store the way it is consumed

- **WHEN** acceptance obtains the store
- **THEN** it mounts the published store artifact into the published runtime image, or it mounts the extracted tarballs read-only, and never a validator-private download path

#### Scenario: The behavioral pass is the per-library smoke-test suite

- **GIVEN** an obtained store with the per-library validators available
- **WHEN** the acceptance run executes its behavioral pass
- **THEN** it runs `lib-validator/run_all.py` inside the obtained store and does not run R package examples or a curated anchor registry

#### Scenario: An absent library is skipped, not failed, by the behavioral pass

- **GIVEN** a library whose smoke test's not-installed guard fires (the library is absent from this store/arch)
- **WHEN** acceptance runs the per-library smoke-test suite
- **THEN** that library is skipped by the behavioral pass, not counted as a failure

#### Scenario: Acceptance does not move any pointer

- **GIVEN** an acceptance run that completes either green or red
- **WHEN** it finishes
- **THEN** `latest/linux-<arch>`, the image `:latest` tag, the store artifact tags, and every published tarball are exactly as the build left them — acceptance mutates nothing

#### Scenario: The acceptance run surfaces a results table

- **WHEN** an acceptance run completes for an architecture
- **THEN** its run summary contains a table of the import-all tally per track and the per-library validator outcome (pass / fail / error / skipped counts and the failing/errored libraries), plus the green/red status

### Requirement: The load check is best-effort with a non-empty-track floor

The store build SHALL run a **load check**. The check
`import`/`library()`/`require()`/`--version`s each installed package, and it derives
that track's `packages.txt` fragment from the set that loaded. A single package's
load failure SHALL NOT fail the track — the package is simply absent from the
fragment. A track that loaded **zero** packages SHALL fail the build (the non-empty
floor), so a degenerate or empty track is never published.

#### Scenario: A single load failure drops one package, not the track

- **GIVEN** one manifest package that installs but fails to load, alongside others that load
- **WHEN** the load check runs
- **THEN** the failing package is absent from the fragment, the track still builds, and the loadable packages are advertised

#### Scenario: An all-failed track fails the build

- **GIVEN** a track in which no package loaded
- **WHEN** the load check runs
- **THEN** the build fails and no track is published

### Requirement: The build emits a per-arch coverage report and guards against regressions

After the load check, the store build SHALL emit a **coverage report**. The report
is a table, per architecture and track, of the wanted, loaded, and missing package
counts and names. The report SHALL diff the loaded set against the last published
store. A regression is a package that the last `linux/amd64` store published, that
the manifest still requests, and that no longer loads. A regression SHALL be
reported and SHALL fail the build. A package that never built for `linux/arm64`
SHALL be reported informationally and SHALL NOT fail the build.

A previously-published package that the manifest **no longer requests** SHALL be
reported as *dropped*, not as a regression. A drop SHALL NOT fail the build, on any
architecture. A removal of a package from the manifest removes it, and any
transitive dependency that came in with it, from the next published set. Thus a
build that treats that as breakage would make a baseline reset necessary before
every intentional removal could ship. The build SHALL print each drop by name, so
an unintended removal is reviewable rather than silent.

#### Scenario: A silent amd64 drop is a regression

- **GIVEN** a package present in the last published `linux/amd64` store, still requested by the manifest, that no longer loads
- **WHEN** the coverage report runs
- **THEN** it is flagged as a regression and the build fails

#### Scenario: An intentional removal is not a regression

- **GIVEN** a package present in the last published `linux/amd64` store that the manifest no longer requests
- **WHEN** the coverage report runs
- **THEN** it is listed by name as dropped and the build does not fail

#### Scenario: A missing arm64 package is tolerated

- **GIVEN** a manifest package that does not build on `linux/arm64`
- **WHEN** the coverage report runs
- **THEN** it is listed as missing for arm64 without failing the build

## REMOVED Requirements

### Requirement: Every layer installs into the runtime mount path

**Reason**: The requirement describes the three-image ladder, in which each layer
installed its own package set under `/mnt/libs/current/…`. One runtime image
remains. It installs no library under that path, and it installs its own two
tracks outside the store mount.

**Migration**: The interior layout of `/mnt/libs/current`
(`r/{cran,bioconductor,github}`, `python/site-packages`) is now owned by the
`lib-store-provisioner` farm-assembly requirement and by the `lib-store` runtime
mount contract. A farm holds no `conda` directory and no `node` directory, because
the image owns those two tracks at `/opt/conda` and at `/opt/node`.

### Requirement: Downstream images extend the store through env-driven install locations

**Reason**: A package store mounts read-only over `/mnt/libs`, so it shadows every
package a downstream `FROM` image installs at `/mnt/libs/current`. The store is
the one source of an analysis package after this change. Thus the shadow is the
normal case, not an edge case, and the extension path cannot work.

**Migration**: Extend the package set with the host provisioner, through
`inflexa store add`, which writes into the store the sandbox actually mounts. A
user who wants a private package set builds their own store rather than their own
image.

### Requirement: Managed-mount tarballs are extracted from the published images

**Reason**: The managed per-track tarballs retire. The managed delivery is
decoupled from OSS. No runtime image carries an R track or a Python track to
extract after the retirement of the variants. Thus the source of the tarballs is
gone.

**Migration**: The content-addressed store publishes from the provisioner workflow
(`.github/workflows/lib-store-provisioner.yml`). A managed mount obtains the store
from the published store artifact, not from per-track tarballs cut out of an image.

### Requirement: A store is validated against an equivalently built image

**Reason**: No runtime image bakes the same package set after the retirement of the
variants. Thus there is no equivalently built image to compare a store against.
Acceptance is the validation.

**Migration**: Acceptance validates the published store on a fresh machine, mounted
read-only into the runtime image. The import-all invariant and the per-library
smoke-test suite are the behavioral pass.
