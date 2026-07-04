# lib-store-builder

[![Build Library Store](https://github.com/inflexa-ai/inf-cli/actions/workflows/lib-store.yml/badge.svg)](https://github.com/inflexa-ai/inf-cli/actions/workflows/lib-store.yml)
[![Validate Library Store](https://github.com/inflexa-ai/inf-cli/actions/workflows/validate-lib-store.yml/badge.svg)](https://github.com/inflexa-ai/inf-cli/actions/workflows/validate-lib-store.yml)

## Overview

The [`sandbox-base`](../sandbox-base/) image ships the language runtimes (R,
Python, Node) but **no analysis packages**. Those live in an external **library
store** mounted read-only into every sandbox at `/mnt/libs`, with the active
version at `/mnt/libs/current`. This directory builds that store.

[`lib-store-manifest.yaml`](./lib-store-manifest.yaml) is the source of truth
for the package set — R (CRAN / Bioconductor / GitHub), Python (pip), Node
(npm), and bioconda system tools. The build reads it, installs everything, and
generates the `packages.txt` the agent reads to discover what is available at
runtime (see the harness `list_available_packages` tool and the
[`lib-store` spec](../../harness/openspec/specs/lib-store/spec.md)).

## Per-track tarballs and bundles

The store ships as **one content-addressed tarball per track** — `cran`,
`bioconductor`, `github`, `python`, `conda`, `node` — each carrying its own
`packages.txt` fragment. A **bundle** is a *client-side selection of tracks*
resolved at download time (not a build artifact):

|Bundle|Tracks|
|-|-|
|`python-conda` (CLI: `core`)|`python`, `conda`, `node`|
|`python-r-conda` (CLI: `full`)|`python`, `conda`, `node`, `cran`, `bioconductor`, `github`|

The R triple (`cran`, `bioconductor`, `github`) travels **all-or-none** — the
three share one `.libPaths()` (`R_LIBS_SITE = github:bioconductor:cran`) and form
a dependency chain. The client assembles a bundle by extracting the selected
tarballs and concatenating their fragments into the single
`/mnt/libs/current/packages.txt` — a step below the harness runtime contract
(the mount is unchanged). Track/bundle metadata is centralized in
[`scripts/lib-store-common.sh`](../../scripts/lib-store-common.sh).

## Architectures

|Arch|Tracks built|Bundles resolvable|
|-|-|-|
|`linux/amd64` (self-hosted 64 GB)|all six|`python-conda`, `python-r-conda`|
|`linux/arm64` (free hosted runner)|`python`, `conda`, `node`|`python-conda`|

r2u serves CRAN as fast `.deb` binaries on amd64 only, and bioconda's aarch64
coverage is patchy, so **only the non-R tracks build on arm64** — which makes
"arm64 R deferred" fall out for free. `packages.txt` is **derived per arch from
what actually loaded**, never templated from the manifest, so an arm64-stripped
package (e.g. `liana[extras]`, whose `pyscipopt`/SCIP dep has no arm64 build) is
absent from the arm64 fragment rather than advertised and broken.

## Two fail-loud validation gates

The advertised set must equal the loadable set, proven on a fresh machine before
`latest` moves. Two gates enforce this in **different environments**:

- **Gate 1 — build-time load test (cheap, in the builder).** Each track stage
  `import`/`library()`/`require()`/`--version`s every installed package and
  **fails the stage on a load failure**, then writes that track's `packages.txt`
  fragment from the set that actually loaded. Lives in the
  [`Dockerfile`](./Dockerfile) track stages (shared R helper:
  `/usr/local/bin/lib-store-loadtest.R`; Python:
  `/usr/local/bin/lib-store-py-loadtest.py`).
- **Gate 2 — after-build validator (extensive, "as a user").** A separate
  workflow ([`validate-lib-store.yml`](../../.github/workflows/validate-lib-store.yml))
  pulls the published store on a **fresh machine** (read-only mount, no network,
  runtime env only) via the real `inflexa libs pull` handler, mounts it in
  `sandbox-base`, and runs the suite under
  [`scripts/lib-store-validate/`](../../scripts/lib-store-validate/): import-all
  (the advertised == loadable invariant), curated real-ops for the compiled
  anchors (`anchors.json`), and — for R — each package's own examples
  (`tools::testInstalledPackage`, network-filtered). **Green promotes
  `latest`; red leaves it and fails the run.** A package can pass Gate 1 and
  fail Gate 2 because the environments differ (a `-dev` lib or a writable cache
  present at build time is absent at runtime) — that is the point.

## Publish model (immutable versions, no drift)

The build publishes to a **write-once** tree and never rewrites a version:

```
 <version>/linux-<arch>/<track>.tar.zst          the tarballs
 <version>/<bundle>/linux-<arch>/manifest.json    the candidate lockfile
                                                  (pins each track's url+sha256+size)
 latest/<bundle>/linux-<arch>/manifest.json       advanced ONLY by a GREEN Gate 2
```

The build writes a **candidate** manifest and never touches `latest`; Gate 2
promotes. Clients dedup-pull by digest (an unchanged track across versions has
the same sha256 → already held → skipped).

## What's here

|Path|Role|
|-|-|
|`Dockerfile`|Multi-stage builder. Tracks branch from `base`: `cran → bioconductor → github` (R, sequential) plus independent `python`, `system-tools` (conda), `node`. Each stage runs Gate 1 and emits its `packages.txt` fragment. No combined `final`/`export` stage — the workflow/scripts extract each track subtree + fragment.|
|`lib-store-manifest.yaml`|The package set plus `base_image`, `r_version`, `python_version`.|
|[`../../scripts/build-libs-local.sh`](../../scripts/build-libs-local.sh)|Build locally, pack per-track tarballs, assemble a bundle into the host lib-store dir.|
|[`../../scripts/lib-store-common.sh`](../../scripts/lib-store-common.sh)|Shared track/bundle metadata (sourced by the scripts + CI).|
|[`../../scripts/lib-store-pack.sh`](../../scripts/lib-store-pack.sh)|Pack a staging tree into per-track `<track>.tar.zst` + `.sha256`.|
|[`../../scripts/lib-store-assemble.sh`](../../scripts/lib-store-assemble.sh)|Assemble a bundle from per-track tarballs into a mountable `current/`.|
|[`../../scripts/lib-store-write-manifest.sh`](../../scripts/lib-store-write-manifest.sh)|Emit a per-bundle-per-arch manifest (the lockfile the CLI consumes).|
|[`../../scripts/lib-store-validate/`](../../scripts/lib-store-validate/)|The Gate 2 suite (`run.sh` + `validate.py` + `anchors/` + `r_examples.R`).|
|[`../../scripts/smoke-test-libs.sh`](../../scripts/smoke-test-libs.sh)|Back-compat wrapper over `lib-store-validate/run.sh`.|
|[`../../.github/workflows/lib-store.yml`](../../.github/workflows/lib-store.yml)|The managed build + immutable publish workflow (amd64 self-hosted + arm64 hosted).|
|[`../../.github/workflows/validate-lib-store.yml`](../../.github/workflows/validate-lib-store.yml)|Gate 2 — pull as a user, mount, validate, promote `latest`.|

## Build

The builder is **not a runtime image** — it exists only to produce the store.
The managed build compiles on large runners and publishes prebuilt bundles; to
build your own, from the **repo root**:

```sh
# All tracks, native platform → assembles python-r-conda into ~/.local/share/inflexa/libs
# (override the destination with INFLEXA_LIB_STORE or --dest).
scripts/build-libs-local.sh

# A single bundle, e.g. core (python + conda + node):
scripts/build-libs-local.sh --bundle python-conda

# A single track, e.g. Python only:
scripts/build-libs-local.sh --python-only

# Validate a built store (mounts it in sandbox-base and runs the derived suite):
scripts/lib-store-validate/run.sh          # import-all + anchors + invariant
scripts/lib-store-validate/run.sh --full   # also the R example pass
```

Notes:

- **amd64 is the primary target.** CRAN installs as fast r2u `.deb` binaries on
  amd64; arm64 builds only the non-R tracks.
- `base_image` in the manifest **must match** `images/sandbox-base`'s
  `BASE_IMAGE` — the store is built against the same R/Python the sandbox runs.
- The GitHub R track hits the GitHub API; set `GITHUB_TOKEN` / `GITHUB_PAT` to
  clear the 60 req/hr anonymous limit.
- A full R + Bioconductor build is heavy on RAM and disk — use `--python-only` /
  `--r-only` / `--tools-only` / `--node-only` to build one track at a time.

## Deferred / not yet built

Recorded here so a future reader finds them (mirrors the change's design notes):

- **Python + R + conda on arm64.** r2u is amd64-only and bioconda aarch64
  coverage is patchy, so arm64 publishes no R tarballs and only `python-conda`
  resolves there. Revisit when arm64 R binaries become viable.
- **Per-track versioning.** v1 treats a version as one coherent build (all
  tracks built together). The manifest pins each track independently, leaving
  room for a python-only change to bump `python`'s digest without rebuilding R —
  not wired yet.
- **Nightly re-validation of `latest`.** Immutable stores don't drift, but the
  `sandbox-base` image and the R network denylist do, so a periodic re-run of
  Gate 2 against `latest` is a future signal. Not built now.
- **CLI setup docs.** The user-facing `inflexa libs pull` / `inflexa setup`
  provisioning docs live in the `cli/` subsystem and are updated there.
