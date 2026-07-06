# lib-store-build Specification

## Purpose
TBD - created by archiving change add-lib-store-bundles-and-validation. Update Purpose after archive.
## Requirements
### Requirement: The store ships as per-track, self-describing tarballs

The build SHALL package the library store as one tarball per **track** —
`cran`, `bioconductor`, `github`, `python`, `conda`, `node` — rather than one
combined archive. Each track tarball SHALL carry its own `packages.txt` fragment
listing that track's contents. Both architectures SHALL attempt every track; the
set of track tarballs produced for an arch SHALL be exactly those that met the
non-empty floor for that arch (best-effort), rather than a fixed per-arch set.

#### Scenario: A track tarball carries its own fragment

- **WHEN** the build produces the `python` track tarball
- **THEN** it carries a `packages.txt` fragment listing exactly that track's loaded packages

#### Scenario: The produced track set is what passed the floor

- **WHEN** the build runs for an architecture
- **THEN** it produces a tarball for each track that met the non-empty floor on that arch, and none for a track that produced no loadable package

### Requirement: packages.txt derives from the verified-loadable set

Each track's `packages.txt` fragment SHALL be generated from the set of packages
that actually **installed and loaded** during the build (the load check), NOT
from the manifest wishlist. A package that fails to load SHALL be absent from the
fragment without, on its own, failing the build. The client (or the baked image)
SHALL surface the single `/mnt/libs/current/packages.txt` consumed by the harness
`list_available_packages` tool as the concatenation of the present tracks'
fragments. The advertised set SHALL therefore never list a package that failed to
load.

#### Scenario: A package that fails to load is not advertised

- **GIVEN** a manifest package that installs but fails its load check
- **WHEN** the track's `packages.txt` fragment is generated
- **THEN** that package is absent from the fragment (and from the concatenated `packages.txt`)

#### Scenario: The mounted or baked packages.txt is the concatenation of present tracks

- **WHEN** a store is assembled by mount or baked into an image
- **THEN** `/mnt/libs/current/packages.txt` is the concatenation of exactly the present tracks' fragments

### Requirement: Builds publish immutable versions selected by a manifest

Each build SHALL publish its track tarballs to a write-once, versioned path
(`<version>/linux-<arch>/<track>.tar.zst`) that SHALL never be rewritten. For
each arch the build SHALL write a **manifest** pinning each track's tarball —
by a store-relative `path` (so a client joins it onto its own resolved base and
a mirror redirects payload downloads, not only the manifest) plus an absolute
`url` for compatibility — and its content digest. Clients SHALL resolve their
arch's manifest and MAY skip re-pulling any track whose digest they already
hold.

Each successful build SHALL advance the mutable `latest/linux-<arch>` pointer
(manifest and coverage baseline) to the version it just published, gated by the
build's own load check + non-empty floor + coverage regression guard — the same
gate that decides whether the build publishes at all. Promotion to `latest` is
NOT deferred to a separate acceptance run. This mirrors the image `:latest` tag,
which the build already advances atomically at publish.

#### Scenario: A published version is never mutated

- **WHEN** a later build runs
- **THEN** it writes a new `<version>/…` tree and leaves every prior version's tarballs byte-identical

#### Scenario: Unchanged tracks dedup on pull

- **GIVEN** a client already holding a track tarball with digest D
- **WHEN** it resolves a manifest that pins the same digest D for that track
- **THEN** it does not re-download that tarball

#### Scenario: A successful build advances latest

- **GIVEN** a build that passes its load check, non-empty floor, and coverage regression guard for an arch
- **WHEN** the build publishes that arch
- **THEN** `latest/linux-<arch>` (manifest + coverage baseline) advances to that version, without waiting on a separate acceptance run

### Requirement: The build publishes three layered sandbox images

The build SHALL publish three runtime images layered by `FROM`:
`sandbox-base` → `sandbox-python` → `sandbox-python-r`. `sandbox-base` SHALL
carry the language runtimes, system libraries, `sandbox-server`, and provenance
hooks, and SHALL contain **no** analysis packages. `sandbox-python` SHALL add
the Python libraries, the bioconda CLI tools, and the Node packages.
`sandbox-python-r` SHALL add the R libraries. Each image SHALL be published for
both `linux/amd64` and `linux/arm64` to GitHub Packages (GHCR) on the
`inflexa-ai/inf-cli` repository (`ghcr.io/inflexa-ai/inf-cli/<image>`) as a
multi-arch manifest, and each SHALL have a committed Dockerfile that a user can
edit or `FROM`.

#### Scenario: The three images layer by FROM

- **WHEN** the images are built
- **THEN** `sandbox-python` is built `FROM sandbox-base` and `sandbox-python-r` is built `FROM sandbox-python`

#### Scenario: Base carries no analysis packages

- **WHEN** `sandbox-base` is inspected
- **THEN** it contains the runtimes, system libraries, `sandbox-server`, and provenance hooks but no R/Python/conda/Node analysis packages, and its `/mnt/libs/current` is empty

#### Scenario: Both architectures are published

- **WHEN** the build publishes the images
- **THEN** each of `sandbox-base`, `sandbox-python`, and `sandbox-python-r` is published for `linux/amd64` and `linux/arm64`

### Requirement: Every layer installs into the runtime mount path

Each image layer SHALL install its packages into `/mnt/libs/current/…` — the
same paths the managed read-only mount uses (`r/{cran,bioconductor,github}`,
`python/site-packages`, `conda`, `node`). A baked image and a mounted store
SHALL therefore present a byte-identical runtime layout, and the harness
`lib-store` runtime mount contract SHALL NOT change.

#### Scenario: A layer installs into the mount path

- **WHEN** `sandbox-python-r` installs its R libraries
- **THEN** they land under `/mnt/libs/current/r/{cran,bioconductor,github}`, the same subtree the managed mount populates

### Requirement: Sandbox images are self-sufficient at runtime

Each published image SHALL bake the package-resolver env (`R_LIBS_SITE` covering
the github/bioconductor/cran subtrees, `NODE_PATH`, `PATH` including the conda
`bin`, and the Python `.pth`) and a `/mnt/libs/current/packages.txt`, so that
running the image with **no** harness and **no** mount resolves imports for its
baked packages and answers `list_available_packages`. Because the baked and
mounted paths are identical, baking this env SHALL be safe under the managed
mount (redundant with, never conflicting with, the harness-injected env).

#### Scenario: A plain docker run resolves baked packages

- **GIVEN** `sandbox-python-r` run directly with no mount and no harness
- **WHEN** a script imports a baked Python package or `library()`s a baked R package
- **THEN** it resolves against `/mnt/libs/current` via the image's baked env

#### Scenario: packages.txt is present in the image

- **WHEN** `list_available_packages` reads `/mnt/libs/current/packages.txt` inside a baked image with no mount
- **THEN** the file exists and lists the image's baked packages

### Requirement: Downstream images extend the store through env-driven install locations

The images SHALL expose `INFLEXA_LIB_ROOT=/mnt/libs/current` as the single source
of truth for the store location, and SHALL set the per-installer target env
(`PIP_TARGET`, `R_LIBS_USER`, the npm prefix) so that a downstream `FROM` image's
default `pip install`, `install.packages()`, and `npm install` land inside the
store and resolve at runtime without path knowledge. The images SHALL provide a
helper that re-derives `/mnt/libs/current/packages.txt` so packages added by a
downstream image surface in `list_available_packages`.

#### Scenario: A FROM image installs without path knowledge

- **GIVEN** a Dockerfile `FROM inflexa/sandbox-python-r` with `RUN pip install mypkg`
- **WHEN** the derived image runs and imports `mypkg`
- **THEN** `mypkg` resolves against `/mnt/libs/current` with no extra path wiring

#### Scenario: Refreshing discovery after an extension

- **GIVEN** a downstream image that installed extra packages and ran the refresh helper
- **WHEN** `list_available_packages` is called
- **THEN** the added packages appear in `packages.txt`

### Requirement: Managed-mount tarballs are extracted from the published images

After the images are published, the build SHALL extract each track's subtree from
the images into the same per-track, content-addressed tarballs the managed mount
consumes (`<version>/linux-<arch>/<track>.tar.zst`), hash them, and publish the
per-arch manifest and the immutable-version layout unchanged. The tarballs' shape,
content-addressing, dedup-by-digest, and immutable versioning SHALL be preserved;
only the source of a tarball changes — an image layer subtree rather than a
throwaway builder's track subtree.

#### Scenario: Tarballs come from the image

- **WHEN** the build extracts the `python` track
- **THEN** it tars `/mnt/libs/current/python` out of the published `sandbox-python` image into `python.tar.zst`

#### Scenario: Managed mount is unchanged

- **GIVEN** the extracted tarballs and per-arch manifest
- **WHEN** the managed service or the CLI pulls and mounts them
- **THEN** the mounted `/mnt/libs/current` is identical to today's, with no change to the pull/mount path

### Requirement: The load check is best-effort with a non-empty-track floor

The build SHALL run a **load check** inside each image build that
`import`/`library()`/`require()`/`--version`s each installed package and derives
that track's `packages.txt` fragment from the set that actually loaded. A single
package's load failure SHALL NOT fail the track — the package is simply absent
from the fragment. A track that loaded **zero** packages SHALL fail the build
(the non-empty floor), so a degenerate or empty track tarball is never published.

#### Scenario: A single load failure drops one package, not the track

- **GIVEN** one manifest package that installs but fails to load, alongside others that load
- **WHEN** the load check runs
- **THEN** the failing package is absent from the fragment, the track still builds, and the loadable packages are advertised

#### Scenario: An all-failed track fails the build

- **GIVEN** a track in which no package loaded
- **WHEN** the load check runs
- **THEN** the build fails and no tarball is published for that track

### Requirement: The build emits a per-arch coverage report and guards against regressions

After the load check, the build SHALL emit a **coverage report** — a table of,
per architecture × track, the wanted / loaded / missing package counts and names.
The report SHALL diff the loaded set against the last published manifest. A
package that was published for `linux/amd64` and is now missing SHALL be reported
as a regression and SHALL fail the build; a package that never built for
`linux/arm64` SHALL be reported informationally and SHALL NOT fail the build.

#### Scenario: A silent amd64 drop is a regression

- **GIVEN** a package present in the last published `linux/amd64` manifest that no longer loads
- **WHEN** the coverage report runs
- **THEN** it is flagged as a regression and the build fails

#### Scenario: A missing arm64 package is tolerated

- **GIVEN** a manifest package that does not build on `linux/arm64`
- **WHEN** the coverage report runs
- **THEN** it is listed as missing for arm64 without failing the build

### Requirement: Each architecture publishes the tracks that pass the floor

The store SHALL remain per-architecture, but each arch SHALL publish the tracks
that met the non-empty floor for that arch on a **best-effort** basis rather than
a fixed pre-declared set. Both `linux/amd64` and `linux/arm64` SHALL attempt every
track; `linux/arm64` MAY therefore publish R tracks when they build. The R tracks
(`cran`, `bioconductor`, `github`) SHALL travel together or not at all, because
they share one R library path and form a dependency chain.

#### Scenario: arm64 publishes R when it builds

- **GIVEN** a build in which the arm64 R tracks meet the floor
- **WHEN** the arm64 manifest is written
- **THEN** it pins the R tracks alongside `python`, `conda`, and `node`

#### Scenario: arm64 omits R when it does not build

- **GIVEN** a build in which the arm64 R tracks fail to produce any loadable package
- **WHEN** the arm64 manifest is written
- **THEN** it pins only the non-R tracks and the coverage report lists the R packages as missing for arm64

### Requirement: Acceptance is a non-gating post-publish validation

After a build publishes, an **acceptance** run SHALL validate the published store
on a **fresh machine** — no network, runtime environment only, correct
architecture — obtaining the store the way it is actually consumed: by **booting
the published image** (the OSS user path — the image `inflexa sandbox pull`
fetches) and/or by **mounting the extracted tarballs read-only** (the managed
path), rather than a validator-private download. It SHALL run, inside the
obtained store:

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
image or tarball — the build already published everything before acceptance runs.
Acceptance SHALL surface, per architecture, a **results table** in its run
summary reporting the import-all tally per track and the per-library validator
outcome (counts of pass / fail / error / skipped, and the failing/errored
libraries), plus an overall green/red status, so a maintainer can review exactly
what was verified.

#### Scenario: Acceptance obtains the store the way it is consumed

- **WHEN** acceptance obtains the store
- **THEN** it boots the published image (the OSS user path) and/or mounts the extracted tarballs read-only (the managed path), rather than a validator-private download path

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
- **THEN** `latest/linux-<arch>`, the image `:latest` tag, and every published tarball are exactly as the build left them — acceptance mutates nothing

#### Scenario: The acceptance run surfaces a results table

- **WHEN** an acceptance run completes for an architecture
- **THEN** its run summary contains a table of the import-all tally per track and the per-library validator outcome (pass / fail / error / skipped counts and the failing/errored libraries), plus the green/red status

