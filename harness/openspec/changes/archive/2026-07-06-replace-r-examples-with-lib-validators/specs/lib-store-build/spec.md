## MODIFIED Requirements

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

## REMOVED Requirements

### Requirement: latest advances only to a validated version

**Reason**: The validator can only coherently gate per-arch tarball pointers,
while the primary OSS artifact — the image `:latest` — is a single multi-arch
tag the build already advances atomically and ungated. Keeping acceptance as a
per-arch promotion gate created two `latest` concepts with mismatched semantics
(image = build-owned/atomic, tarball = acceptance-owned/per-arch) and could not
be reconciled with the best-effort arm64 stance (a per-arch gate would let
`latest/amd64` and `latest/arm64` diverge, while an atomic all-arch gate would
let patchy arm64 block amd64). Builds are infrequent and reviewed manually, so
acceptance becomes a non-gating validation that reports what it verified rather
than an automated promotion gate.

**Migration**: `latest/linux-<arch>` is now advanced by the build itself (see
"Builds publish immutable versions selected by a manifest"), gated by the build
floor. Acceptance no longer copies `latest`; it validates the published store on
a fresh machine and reports a per-arch results table + green/red status for
manual review (see "Acceptance is a non-gating post-publish validation").

## ADDED Requirements

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
