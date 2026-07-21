# Sandbox images

The container images analyses execute in, and the manifest that defines what they
contain. Everything here is built from one package-set source of truth —
[`lib-store-manifest.yaml`](./lib-store-manifest.yaml) — and published to GHCR by
[`.github/workflows/lib-store.yml`](../.github/workflows/lib-store.yml).

## The image ladder

Three images, each layering `FROM` the one above it. You pick a **variant**
(`python` or `python-r`); `sandbox-base` is infrastructure, not something an OSS
user runs directly.

| Image | Is | Adds | Who runs it |
|-|-|-|-|
| [`sandbox-base/`](./sandbox-base) | The lean base: R 4.6.0, Python 3.12, Node 20, Chromium, and the Go `sandbox-server` that speaks the harness exec protocol. Its `/mnt/libs/current` is **empty**. | — | The **managed** service, which pulls it per node and mounts the per-track library tarballs read-only. Kept lean because a few hundred MB of packages would be a real cold-start tax — Chromium is the one deliberate exception, since the managed path mounts `kaleido` onto this image and would otherwise have nothing to render figures with. |
| [`sandbox-python/`](./sandbox-python) | `FROM sandbox-base` | The Python libraries, the bioconda CLI tools (samtools, bcftools, bedtools, …), and the Node package(s) (echarts). | OSS users who don't need R. |
| [`sandbox-python-r/`](./sandbox-python-r) | `FROM sandbox-python` | The R libraries (CRAN, Bioconductor, GitHub). The full analysis environment. | OSS users — the default, most complete variant. |

The two variant images **bake the library store in** at `/mnt/libs/current` — the
exact paths the managed read-only mount uses, so a baked image and a mounted store
present a byte-identical runtime layout and the harness `lib-store` contract is the
same either way. No mount, no local `~/.local/share/inflexa/libs` tree, no
architecture-forcing.

`sandbox-base`'s own [README](./sandbox-base/README.md) documents the exec
protocol, the transport modes, and the egress firewall — the security-relevant
machinery. Read it before changing anything under `sandbox-base/`.

## Getting an image

Through the CLI, which also records the pulled tag in `config.json` so sandboxes
use it:

```sh
inflexa sandbox pull python-r     # or: python
inflexa sandbox status            # configured variant, GHCR ref, local presence, digest
```

Or directly — the published images are multi-arch manifests, so `docker pull`
resolves your architecture automatically:

```sh
docker run --rm ghcr.io/inflexa-ai/sandbox-python-r:latest \
  Rscript -e 'library(Seurat); sessionInfo()'

docker run --rm ghcr.io/inflexa-ai/sandbox-python:latest \
  python3 -c "import scanpy; print(scanpy.__version__)"
```

The store is baked and the resolver env is baked in, so a plain `docker run` —
**no harness, no mount** — resolves imports for the baked packages and answers
`list_available_packages` (it reads `/mnt/libs/current/packages.txt`).

Images publish to `ghcr.io/inflexa-ai/sandbox-{base,python,python-r}`, tagged
`latest` and `<date>-<sha>`.

## Extending an image (`FROM`)

Add your own packages without knowing any store paths — the image exports the
install targets, so a normal `pip install` / `install.packages()` lands in the
store and resolves at runtime:

```dockerfile
FROM ghcr.io/inflexa-ai/sandbox-python-r:latest
RUN pip install my-extra-package
RUN Rscript -e 'install.packages("mypkg", repos="https://cloud.r-project.org")'
RUN inflexa-libs-refresh    # surface the additions in list_available_packages
```

| Env var | Points at | So that |
|-|-|-|
| `INFLEXA_LIB_ROOT` | `/mnt/libs/current` | single source of truth for the store location |
| `PIP_TARGET` | `$INFLEXA_LIB_ROOT/python/site-packages` | `pip install X` lands in the store |
| `R_LIBS_USER` | `$INFLEXA_LIB_ROOT/r/github` | `install.packages("X")` lands in the store (`sandbox-python-r`) — it is the first writable `.libPaths()` entry |
| `NPM_CONFIG_PREFIX` | `$INFLEXA_LIB_ROOT/node` | `npm install -g X` lands in the store |

conda/mamba already take `-p $INFLEXA_LIB_ROOT/conda`. Always run
`inflexa-libs-refresh` after installing, so the additions appear in
`packages.txt`.

**The published images ship no build toolchain** — they are deliberately lean.
Compiling a source package (a Python package with no wheel, an R package from
source) needs `build-essential` and the relevant `-dev` headers added in your own
`FROM` stage.

Point a sandbox at your own extended image by setting `harness.sandboxImage` in
`config.json`.

## The library store manifest

[`lib-store-manifest.yaml`](./lib-store-manifest.yaml) is the **single
package-set source of truth** consumed by all the image builds. Add a package
there, never in a Dockerfile.

It pins the runtime versions (`r_version`, `python_version`, `base_image`) and
lists packages by **track**:

| Track | Holds |
|-|-|
| `r.cran` | CRAN packages. Transitive CRAN deps of Bioconductor packages are listed **explicitly** — otherwise BiocManager pulls them via bspm+apt during the Bioconductor stage, where they land outside the store subtree. |
| `r.bioconductor` | Bioconductor packages. |
| `r.github` | R packages installed from GitHub (`owner/repo`). |
| `python.pip` | Python packages, under `common` (all arches). |
| `node` | Node packages — a flat list, not arch-split. `echarts` backs chart/report rendering. |
| `system_tools` | Bioinformatics CLI tools from bioconda, split `common` (every arch) / `amd64` (tools with no linux-aarch64 bioconda package). |

`base_image` must match the `BASE_IMAGE` build arg used for `sandbox-base` — the
sandbox runtime and the library store are built against the same R/Python.

Build-time dependencies (compilers, `-dev` headers) are **not** in the manifest:
they live in the builder stages, via
[`install-build-toolchain.sh`](./install-build-toolchain.sh). Runtime system
libraries live in `sandbox-base/Dockerfile`.

## Architecture support

Published for `linux/amd64` and, best-effort, `linux/arm64`.

R on amd64 installs fast via r2u (CRAN as `.deb` binaries). On arm64, r2u is
amd64-only, so CRAN falls back to a source compile and Bioconductor is source-only
and patchy — the arm64 `sandbox-python-r` is **best-effort**: whatever R actually
builds and loads is shipped, the rest is dropped and reported in the build's
coverage report. If arm64 R does not build at all, no arm64 `sandbox-python-r` is
published; `sandbox-python` (Python + conda + Node) still is.

The amd64 build needs a large self-hosted runner (`inflexa-builder`) — the full R +
Bioconductor compile does not fit a GitHub-hosted runner.

## Building locally

Build from the **repo root** — every Dockerfile `COPY`s
`images/lib-store-manifest.yaml` — passing the image each one layers onto:

```sh
docker build -f images/sandbox-base/Dockerfile \
  --build-arg BASE_IMAGE=rocker/r-ver:4.6.0 \
  -t sandbox-base:local .

docker build -f images/sandbox-python/Dockerfile \
  --build-arg SANDBOX_BASE_IMAGE=sandbox-base:local \
  -t sandbox-python:local .

docker build -f images/sandbox-python-r/Dockerfile \
  --build-arg SANDBOX_PYTHON_IMAGE=sandbox-python:local \
  -t sandbox-python-r:local .
```

[`scripts/build-libs-local.sh`](../scripts/build-libs-local.sh) reproduces the
whole layered build in one go.

Each variant build compiles and installs its tracks in throwaway `*-builder`
stages, runs a best-effort **load check** (a package that fails to load is dropped
from its `packages.txt` fragment; a track that loaded zero packages fails the
build), then copies the finished subtrees into a lean runtime stage. The R tracks
run sequentially — CRAN → Bioconductor → GitHub share one `.libPaths()` and a
dependency chain, so they travel together or not at all. Pass a `github_token`
build secret to raise the GitHub API budget for the GitHub R stage.

## Contributing

- **Packages** belong in [`lib-store-manifest.yaml`](./lib-store-manifest.yaml),
  not in a Dockerfile.
- **Keep the runtime stages lean.** Build tooling (compilers, r2u, `-dev` headers)
  belongs only in the `*-builder` stages.
- **Changes under `sandbox-base/`** touch the containment boundary — the exec
  protocol, the signed endpoints, the egress firewall. Read
  [`sandbox-base/README.md`](./sandbox-base/README.md) and
  [`SECURITY.md`](../SECURITY.md) first, run `go test ./...` inside
  `sandbox-base/server/`, and call out anything that loosens isolation explicitly.
