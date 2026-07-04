# lib-store-build Specification

## Purpose
TBD - created by archiving change add-lib-store-bundles-and-validation. Update Purpose after archive.
## Requirements
### Requirement: The store ships as per-track, self-describing tarballs

The build SHALL package the library store as one tarball per **track** —
`cran`, `bioconductor`, `github`, `python`, `conda`, `node` — rather than one
combined bundle. Each track tarball SHALL carry its own `packages.txt` fragment
listing that track's contents. The set of track tarballs produced SHALL depend
on the target architecture: `linux/amd64` SHALL produce all six; `linux/arm64`
SHALL produce only the non-R tracks (`python`, `conda`, `node`).

#### Scenario: amd64 produces all tracks

- **WHEN** the build runs for `linux/amd64`
- **THEN** it produces `cran`, `bioconductor`, `github`, `python`, `conda`, and `node` track tarballs, each with a `packages.txt` fragment

#### Scenario: arm64 omits the R tracks

- **WHEN** the build runs for `linux/arm64`
- **THEN** it produces only `python`, `conda`, and `node` track tarballs, and no `cran`/`bioconductor`/`github` tarballs exist for that arch

### Requirement: A bundle is a named selection of tracks

A **bundle** SHALL be a named set of tracks resolved at download time, not a
build artifact. The system SHALL define `python-conda` = `{python, conda, node}`
and `python-r-conda` = `{python, conda, node, cran, bioconductor, github}`. The
R tracks (`cran`, `bioconductor`, `github`) SHALL be selected together or not at
all, because they share one R library path and form a dependency chain. Because
arm64 has no R tarballs, only `python-conda` SHALL be resolvable on arm64.

#### Scenario: Full bundle pulls the R triple as a unit

- **WHEN** a client resolves `python-r-conda`
- **THEN** it pulls `cran`, `bioconductor`, and `github` together with `python`, `conda`, and `node`

#### Scenario: Full bundle is unavailable on arm64

- **WHEN** a client resolves `python-r-conda` for `linux/arm64`
- **THEN** resolution fails (no R tarballs are published for arm64) and only `python-conda` is offered

### Requirement: packages.txt derives from the verified-loadable set

Each track's `packages.txt` fragment SHALL be generated from the set of packages
that actually **installed and loaded** during the build (Gate 1), NOT from the
manifest wishlist. The client SHALL concatenate the fragments of the pulled
tracks into the single `/mnt/libs/current/packages.txt` consumed by the harness
`list_available_packages` tool. The advertised set SHALL therefore never list a
package that failed to load.

#### Scenario: A package that fails to load is not advertised

- **GIVEN** a manifest package that installs but fails its build-time load test
- **WHEN** the track's `packages.txt` fragment is generated
- **THEN** that package is absent from the fragment (and from the concatenated `packages.txt`)

#### Scenario: The mounted packages.txt is the concatenation of pulled tracks

- **WHEN** a client pulls a bundle and assembles the store
- **THEN** `/mnt/libs/current/packages.txt` is the concatenation of exactly the pulled tracks' fragments

### Requirement: Builds publish immutable versions selected by a manifest

Each build SHALL publish its track tarballs to a write-once, versioned path
(`<version>/linux-<arch>/<track>.tar.zst`) that SHALL never be rewritten. For
each bundle × arch the build SHALL write a **manifest** pinning each track's
tarball — by a store-relative `path` (so a client joins it onto its own resolved
base and a mirror redirects payload downloads, not only the manifest) plus an
absolute `url` for compatibility — and its content digest. Clients SHALL resolve
a bundle through its manifest and MAY skip re-pulling any track whose digest they
already hold.

#### Scenario: A published version is never mutated

- **WHEN** a later build runs
- **THEN** it writes a new `<version>/…` tree and leaves every prior version's tarballs byte-identical

#### Scenario: Unchanged tracks dedup on pull

- **GIVEN** a client already holding a track tarball with digest D
- **WHEN** it resolves a manifest that pins the same digest D for that track
- **THEN** it does not re-download that tarball

### Requirement: Two fail-loud validation gates in distinct environments

The pipeline SHALL enforce two fail-loud gates. **Gate 1** SHALL run in the
build environment: it SHALL `import`/`library()` each installed package and SHALL
fail the build on a load failure, and it produces the per-track `packages.txt`.
**Gate 2** SHALL run after publish, on a **fresh machine** (read-only mount, no
network, runtime environment only, correct architecture), SHALL obtain the
published store the same way a user does, and SHALL run the extensive validation
suite. Gate 1 SHALL NOT be treated as sufficient — a package passing Gate 1 can
still fail Gate 2 because the environments differ.

#### Scenario: Gate 1 fails the build on a build-environment load failure

- **GIVEN** an installed package that does not load in the builder
- **WHEN** Gate 1 runs
- **THEN** the build fails and the package is excluded from `packages.txt`

#### Scenario: Gate 2 catches a build-vs-runtime divergence

- **GIVEN** a package that loads in the builder but not on a fresh runtime machine (e.g. it needs a `-dev` library or a writable cache absent at runtime)
- **WHEN** Gate 2 runs
- **THEN** Gate 2 fails even though Gate 1 passed

### Requirement: latest advances only to a validated version

Gate 2 SHALL obtain the candidate store by invoking the same CLI pull handler an
end user runs, and SHALL run: `import`/`library()`/`require()` for **every**
advertised package; a curated real operation for the compiled anchor packages; a
network-filtered pass of R packages' own examples; and a check that the
advertised `packages.txt` equals the actually-loadable set. Only when Gate 2 is
green SHALL the `latest/<bundle>/<arch>` pointer be advanced to that version. A
red Gate 2 SHALL leave `latest` unchanged and surface a failing status.

#### Scenario: Green validation promotes latest

- **GIVEN** a freshly published version whose Gate 2 run is green
- **WHEN** validation completes
- **THEN** `latest/<bundle>/<arch>` is advanced to that version

#### Scenario: Red validation does not promote

- **GIVEN** a freshly published version whose Gate 2 run is red
- **WHEN** validation completes
- **THEN** `latest/<bundle>/<arch>` still points at the previous validated version and the run reports failure

#### Scenario: The validator pulls as a user does

- **WHEN** Gate 2 obtains the store
- **THEN** it uses the same `inflexa libs pull` handler the interactive setup flow uses, rather than a validator-private download path

