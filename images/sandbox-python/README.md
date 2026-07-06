# sandbox-python

## Overview

[`sandbox-base`](../sandbox-base) + the **Python libraries**, the **bioconda CLI
tools**, and the **Node package(s)** (echarts). Everything installs into `/mnt/libs/current/…`
— the exact paths the managed read-only mount uses — so a baked image and a
mounted store present a byte-identical runtime layout, and the harness `lib-store`
runtime contract is unchanged.

For R as well, use [`sandbox-python-r`](../sandbox-python-r), which layers `FROM`
this image.

## Run it

```sh
docker run --rm ghcr.io/inflexa-ai/sandbox-python:latest \
  python3 -c "import scanpy; print(scanpy.__version__)"
```

The store is baked at `/mnt/libs/current`, and the resolver env is baked in, so a
plain `docker run` — **no harness, no mount** — resolves imports for the baked
packages and answers `list_available_packages` (it reads
`/mnt/libs/current/packages.txt`). The published image is a multi-arch manifest,
so `docker pull` resolves the host architecture automatically.

## Extend it (`FROM`)

Add your own packages without knowing any store paths — the image exports the
install targets:

```dockerfile
FROM ghcr.io/inflexa-ai/sandbox-python:latest
# PIP_TARGET is baked → this lands in the store and resolves at runtime.
RUN pip install my-extra-package
# Surface the addition in list_available_packages.
RUN inflexa-libs-refresh
```

| Env var | Points at | So that |
|-|-|-|
| `INFLEXA_LIB_ROOT` | `/mnt/libs/current` | single source of truth for the store location |
| `PIP_TARGET` | `$INFLEXA_LIB_ROOT/python/site-packages` | `pip install X` lands in the store |
| `R_LIBS_USER` | `$INFLEXA_LIB_ROOT/r/github` | `install.packages("X")` lands in the store (in `sandbox-python-r`) |
| `NPM_CONFIG_PREFIX` | `$INFLEXA_LIB_ROOT/node` | `npm install -g X` lands in the store |

conda/mamba already take `-p $INFLEXA_LIB_ROOT/conda`. Run
`inflexa-libs-refresh` after installing so the additions appear in
`packages.txt`. Building a source package (no wheel) needs a compiler — add
`build-essential` in your own `FROM` stage; the published image is lean and ships
no build toolchain.

## Build

Build from the **repo root** (the Dockerfile `COPY`s
`images/lib-store-manifest.yaml`), passing the base image it layers onto:

```sh
docker build -f images/sandbox-python/Dockerfile \
  --build-arg SANDBOX_BASE_IMAGE=sandbox-base:local \
  -t sandbox-python:local .
```

The build compiles/installs each track in throwaway `*-builder` stages, runs a
best-effort **load check** (a single package that fails to load is dropped from
its `packages.txt` fragment; a track that loaded zero packages fails the build),
then copies the finished subtrees into a lean `FROM sandbox-base` runtime stage.
[`.github/workflows/lib-store.yml`](../../.github/workflows/lib-store.yml) builds
and pushes it to GHCR; [`scripts/build-libs-local.sh`](../../scripts/build-libs-local.sh)
reproduces the layered build locally.

## Contributing

The package set lives in
[`../lib-store-manifest.yaml`](../lib-store-manifest.yaml) — edit it there, not in
the Dockerfile. Keep the runtime stage lean: build tooling belongs only in the
`*-builder` stages.
