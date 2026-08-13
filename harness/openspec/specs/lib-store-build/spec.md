# lib-store-build Specification

## Purpose

This capability is the build pipeline for the library store and the sandbox
runtime image. The pipeline installs each package, then does a load check with a
non-empty-track floor. It emits a per-architecture coverage report that guards
against a regression.

The pipeline publishes the package set in two forms. The first form is one tarball
for each track. The second form is a content-addressed store, which it pushes to
GHCR as an OCI artifact. It publishes an immutable version that a manifest selects.

The pipeline publishes one sandbox runtime image, `sandbox-base`. The image carries
the interpreters and the two image-owned tracks, but no R library and no Python
library. After the pipeline publishes, an acceptance run validates the store on a
fresh machine. The acceptance run is not a gate, and it moves no pointer.

## Requirements

### Requirement: The store ships as per-track, self-describing tarballs

The build MUST package the library store as one tarball per **track** —
`cran`, `bioconductor`, `github`, `python`, `conda`, `node` — rather than one
combined archive. Each track tarball MUST carry its own `packages.txt` fragment
that lists that track's contents. Both architectures MUST attempt every track.
For an arch, the set of track tarballs is best-effort. That set MUST be exactly
the tracks that met the non-empty floor for that arch, and not a fixed per-arch
set.

This form remains the published artifact for the managed mount only, until the
managed delivery change replaces it (decoupled, 2026-08-05). It is one of two
forms the build can emit. The content-addressed store is the other, and it is the
published artifact for the CLI channel.

#### Scenario: A track tarball carries its own fragment

- **WHEN** the build produces the `python` track tarball
- **THEN** it carries a `packages.txt` fragment that lists exactly that track's loaded packages

#### Scenario: The produced track set is what passed the floor

- **WHEN** the build runs for an architecture
- **THEN** it produces a tarball for each track that met the non-empty floor on that arch, and none for a track with no loadable package

#### Scenario: Emitting the content-addressed form does not change the tarballs

- **WHEN** the build emits both forms
- **THEN** the track tarballs, their fragments, and their digests are what they would have been without the second form

### Requirement: packages.txt derives from the verified-loadable set

The build MUST generate each track's `packages.txt` fragment from the set of
packages that actually **installed and loaded** during the build (the load
check). The build MUST NOT generate the fragment from the manifest wishlist. A
package that fails to load MUST be absent from the fragment. That absence, on its
own, MUST NOT fail the build. The client (or the baked image) MUST surface the
single `/mnt/libs/current/packages.txt` consumed by the harness
`list_available_packages` tool as the concatenation of the present tracks'
fragments. Thus the advertised set MUST never list a package that failed to
load.

#### Scenario: A package that fails to load is not advertised

- **GIVEN** a manifest package that installs but fails its load check
- **WHEN** the track's `packages.txt` fragment is generated
- **THEN** that package is absent from the fragment (and from the concatenated `packages.txt`)

#### Scenario: The mounted or baked packages.txt is the concatenation of present tracks

- **WHEN** a store is assembled by mount or baked into an image
- **THEN** `/mnt/libs/current/packages.txt` is the concatenation of exactly the present tracks' fragments

### Requirement: Builds publish immutable versions selected by a manifest

Each build MUST publish its track tarballs to a write-once, versioned path
(`<version>/linux-<arch>/<track>.tar.zst`) that MUST never be rewritten. For
each arch the build MUST write a **manifest**. The manifest MUST pin each track's
tarball and its content digest. The pin MUST carry a store-relative `path`, and
an absolute `url` for compatibility. A client joins the store-relative `path` onto
its own resolved base. Thus a mirror redirects the payload downloads, not only
the manifest. A client MUST resolve the manifest of its arch. The client can skip
the download of any track whose digest it already holds.

Each successful build MUST advance the mutable `latest/linux-<arch>` pointer
(manifest and coverage baseline) to the version that it just published. The gate
is the build's own load check + non-empty floor + coverage regression guard. That
gate is the same gate that decides whether the build publishes at all. Promotion
to `latest` is NOT deferred to a separate acceptance run. This mirrors the image
`:latest` tag, which the build already advances atomically at publish.

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

### Requirement: The build publishes one sandbox runtime image

The build MUST publish exactly one runtime image, `sandbox-base`. That image
MUST carry the language interpreters (R, Python, and Node.js), the system
libraries, `sandbox-server`, and the provenance hooks. It MUST also carry each
track that a package farm cannot carry: the conda prefix with the bioconda
command-line tools, and the Node packages. It MUST contain **no** R library and
**no** Python library. Its `/mnt/libs/current` MUST be empty, so the mounted
package store is the one source of a library. The build MUST NOT publish a
variant image that bakes a library set: `sandbox-python` and `sandbox-python-r`
are retired.

The image, and never the store, MUST supply each interpreter. R comes from the
digest-pinned base image the manifest names as `base_image`, and Python and
Node.js come from apt in that same image. A package store MUST NOT carry an
interpreter, thus a store MUST NOT change the R version, the Python version, or
the Node version.

The image MUST place the conda prefix and the Node packages **outside** the store
mount path. A package store mounts read-only over `/mnt/libs`, thus it shadows
each path the image bakes below `/mnt/libs`. The conda prefix MUST be at
`/opt/conda` and the Node packages MUST be at `/opt/node`.

The build MUST **make** the conda prefix at that final path. Conda writes the
absolute prefix path into each shebang and each RPATH. Thus the build MUST NOT
build the prefix elsewhere and then copy, link, or move it. The prefix MUST carry
the bioconda tool set, the channel list, and the strict channel priority the
retired conda-builder stage used. It MUST keep that stage's non-empty-tool floor.

The image MUST be published for both `linux/amd64` and `linux/arm64` to GitHub
Packages (GHCR) on the `inflexa-ai/inflexa` repository
(`ghcr.io/inflexa-ai/sandbox-base`), as a multi-arch manifest. It MUST have a
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
- **THEN** it makes the prefix at `/opt/conda` directly, and it never copies, links, or moves a prefix built at another path

#### Scenario: Both architectures are published

- **WHEN** the build publishes the image
- **THEN** `sandbox-base` is published for `linux/amd64` and `linux/arm64`

### Requirement: Sandbox images are self-sufficient at runtime

The published runtime image MUST bake the package-resolver env and the mount
points the store expects. The env is `R_LIBS_SITE` over the
github/bioconductor/cran subtrees, the Python `.pth`, and `INFLEXA_LIB_ROOT`.
Thus the image with a mounted store and **no** harness resolves imports and
answers `list_available_packages`. The baked env and the harness-injected env name
the same paths, thus the baked env MUST be safe under the managed mount
(redundant with, never in conflict with, the harness-injected env).

The env for the two image-owned tracks MUST name their baked paths, not a path
under the store mount. `PATH` MUST carry `/opt/conda/bin` and `NODE_PATH` MUST
be `/opt/node/node_modules`. The harness-injected env MUST name the same two
paths, so a mounted store never removes the tools of the image.

The image MUST carry the shared `packages.txt` producer, so a store assembled by
any route reports its inventory in one shape. The image MUST NOT bake a
`/mnt/libs/current/packages.txt`, because `/mnt/libs/current` is empty.

The image MUST bake an inventory fragment that lists the two image-owned tracks:
the bioconda command-line tools and the Node packages. The build MUST derive the
fragment from the sets the load check resolved, thus the record matches what the
image installed and it cannot drift. The fragment MUST live at a path outside the
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

### Requirement: The load check is best-effort with a non-empty-track floor

The store build MUST run a **load check**. The check
`import`/`library()`/`require()`/`--version`s each installed package, and it derives
that track's `packages.txt` fragment from the set that loaded. A single package's
load failure MUST NOT fail the track — the package is simply absent from the
fragment. A track that loaded **zero** packages MUST fail the build (the non-empty
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

After the load check, the store build MUST emit a **coverage report**. The report
is a table, per architecture and track, of the wanted, loaded, and missing package
counts and names. The report MUST diff the loaded set against the last published
store. A regression is a package that the last `linux/amd64` store published, that
the manifest still requests, and that no longer loads. A regression MUST be
reported and MUST fail the build. A package that never built for `linux/arm64`
MUST be reported informationally and MUST NOT fail the build.

A previously-published package that the manifest **no longer requests** MUST be
reported as *dropped*, not as a regression. A drop MUST NOT fail the build, on any
architecture. A removal of a package from the manifest removes it, and any
transitive dependency that came in with it, from the next published set. Thus a
build that treats that as breakage would make a baseline reset necessary before
every intentional removal could ship. The build MUST print each drop by name, so
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

### Requirement: Each architecture publishes the tracks that pass the floor

The store MUST remain per-architecture. Each arch MUST publish the tracks that
met the non-empty floor for that arch. That set is **best-effort**, and it is not
a fixed pre-declared set. Both `linux/amd64` and `linux/arm64` MUST attempt every
track. Thus `linux/arm64` can publish R tracks when they build. The R tracks
(`cran`, `bioconductor`, `github`) MUST travel together or not at all, because
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

After a build publishes, an **acceptance** run MUST validate the published store
on a **fresh machine** — no network, runtime environment only, correct
architecture. The run MUST obtain the store the way a consumer obtains it. Two
routes serve: **the published store artifact, mounted read-only into the published
runtime image** (the user path), and **the extracted tarballs, mounted read-only**
(the managed path). Acceptance MUST NOT use a validator-private download. It
MUST run, inside the obtained store:

1. **the import-all invariant** — `import`/`library()`/`require()` for **every**
   advertised package, and a check that the advertised `packages.txt` equals the
   actually-loadable set (advertised ⊆ loadable).
2. **the per-library smoke-test suite** (`lib-validator/run_all.py`) — the
   behavioral pass: each covered library's self-contained smoke test runs a real
   operation and reports pass, not-installed, or fail. An installed-but-broken
   library counts as a failure. An absent library (its not-installed guard fires)
   is a skip.

Acceptance MUST NOT run R packages' own examples. Acceptance MUST NOT maintain a
curated anchor-operation registry. The per-library smoke-test suite is the sole
behavioral pass, and it covers both R and Python. Acceptance MUST NOT move
`latest` or any other consumer-facing pointer. Acceptance MUST NOT publish, tag,
or mutate any image, store artifact, or tarball. The build already published
everything before acceptance runs.

Acceptance MUST surface a **results table** in its run summary, for each
architecture. The table gives the import-all tally per track, the per-library
validator outcome (counts of pass / fail / error / skipped, and the
failing/errored libraries), and an overall green/red status. Thus a maintainer
can review exactly what the run validated.

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

### Requirement: The build can publish a content-addressed store alongside the track tarballs

The build MUST be able to emit the package set as per-distribution, content-addressed directories in addition to the per-track tarballs it already produces. The two forms MUST describe the same package set for a given manifest and architecture. Either form MUST be usable as `/mnt/libs` without a change to the runtime contract.

The content-addressed form MUST carry the same `packages.txt`, produced by the same generator, so a consumer cannot tell from the inventory which form it received.

#### Scenario: Both forms describe the same package set

- **GIVEN** one manifest and one architecture
- **WHEN** the build emits both the track tarballs and the content-addressed store
- **THEN** the package names and versions in each are identical

#### Scenario: Either form mounts unchanged

- **GIVEN** a content-addressed store assembled into a farm
- **WHEN** it is mounted at `/mnt/libs`
- **THEN** the sandbox resolves imports exactly as it does from an extracted tarball store

### Requirement: The content-addressed store publishes to GHCR as an OCI artifact

The build MUST publish the content-addressed store to GHCR as an OCI artifact,
through an ORAS push. It MUST push one artifact for each architecture, with one
layer for each track. A track layer MUST hold the store directories of that
track's packages, as a tar that keeps symlinks. One more layer MUST hold the
farms, the `current` pointer, and the empty mount points. Extraction of all the
layers MUST reassemble the store root exactly. The OCI manifest MUST carry the
sha256 digest of each layer. A version tag MUST be immutable in content: the
build MUST refuse to publish a version again with different content, rather
than move the tag. A `latest` pointer MUST be a tag move only. The artifact
MUST be pullable anonymously, over https, with no credentials.

#### Scenario: One artifact for each architecture

- **WHEN** the build publishes the store for an architecture
- **THEN** it pushes one OCI artifact whose layers are the tracks of that architecture, and each layer descriptor carries its sha256 digest

#### Scenario: A version built again with different bytes is refused

- **GIVEN** a published version tag
- **WHEN** the build publishes the same version with different content
- **THEN** the push fails loudly, and the tag does not move

#### Scenario: An anonymous consumer can pull

- **GIVEN** a published store artifact
- **WHEN** a client with no credentials requests the token, the manifest, and a blob, over https
- **THEN** the registry serves each of them

### Requirement: Cache preparation is verified to take effect at run time

The build MUST make sure that the runtime uses a prepared cache, and that the
cache is not merely present on disk. It MUST run a workload that exercises code
which compiles at the first call. It MUST run that workload as the unprivileged
runtime user, against the read-only store. It MUST load every cache entry that
the preparation run recorded. A run that writes a new cache entry for a prepared
code path MUST fail the check.

A write outside the recorded set MUST NOT fail the check. Such a write names a
kernel that the preparation could not cache, and no workload can prevent it.

The presence of cache files MUST NOT count as evidence that the cache is
effective.

The build MUST prepare the caches before it runs that check. A build that
prepares nothing publishes a store with no cache, thus the check has nothing to
prove. The preparation step MUST mount the target farm at the container path that
the sandbox imports from.

The manifest MUST declare the workload. The build MUST read that declaration and
pass it to the provisioner, and it MUST NOT carry a list of its own. Thus the
workload and the packages that it exercises change in one file.

The build MUST run the R load check in the sandbox runtime image, against the
farm that it published. A failure MUST stop the build before it publishes the
catalog artifact, because that artifact is the publish which reaches a user.

#### Scenario: An ineffective prepared cache fails the build

- **GIVEN** a store whose caches sit where the runtime cannot read them
- **WHEN** the verification workload runs
- **THEN** the check observes cache writes at run time and fails

#### Scenario: An effective prepared cache passes

- **GIVEN** a store whose caches sit where the runtime reads them
- **WHEN** the verification workload runs
- **THEN** the check observes a load for each recorded entry, and it passes

#### Scenario: A write outside the recorded set passes

- **GIVEN** a workload that reaches a kernel which the preparation could not cache
- **WHEN** the verification workload runs
- **THEN** the check reports that write, and it passes because the entry is in no record

#### Scenario: A build that prepares no cache fails

- **GIVEN** a build that publishes a store and runs no preparation step
- **WHEN** the verification workload runs
- **THEN** the check observes cache writes at run time and fails

#### Scenario: The workload comes from the manifest

- **GIVEN** a manifest that names the modules and the workload script
- **WHEN** the build prepares the caches
- **THEN** it reads that declaration, passes it to the provisioner, and names no module of its own

#### Scenario: An R package that the runtime image cannot load stops the build

- **GIVEN** a published farm holding an R package that does not load in the sandbox runtime image
- **WHEN** the build runs the load check in that image
- **THEN** the build fails and publishes no catalog artifact
