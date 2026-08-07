# Sandbox images

The container images that an analysis executes in, and the manifest that defines
what they contain. Everything here is built from one package-set source of truth —
[`lib-store-manifest.yaml`](./lib-store-manifest.yaml) — and published to GHCR by
[`.github/workflows/lib-store.yml`](../.github/workflows/lib-store.yml).

## The one runtime image

There is one runtime image, [`sandbox-base/`](./sandbox-base). It carries R 4.6.0,
Python 3.12, Node.js 20, Chromium, the runtime system libraries, and the Go
`sandbox-server` that speaks the harness exec protocol.

The image also carries the two tracks that a package farm cannot carry:

| Track | Path | Why the image owns it |
|-|-|-|
| conda | `/opt/conda` | A conda prefix writes its absolute path into each shebang and each RPATH. Thus a prefix cannot move after the build, and a farm swaps its path at publish time. |
| Node | `/opt/node` | npm hoists one flat `node_modules` tree, which does not divide into one directory for each package. A Python distribution and an R package do divide that way. |

Both paths are **outside** `/mnt/libs`. A package store mounts read-only over
`/mnt/libs`, thus it shadows each path that the image bakes below `/mnt/libs`.

The image bakes **no** R library and **no** Python library. Its
`/mnt/libs/current` is empty, thus the mounted package store is the one source of
a library. A sandbox with no store carries the runtimes and the two image-owned
tracks, and no library.

The rule has two halves:

- The image owns each language interpreter, the system libraries, and each track
  that a farm cannot carry.
- The store owns the packages of the two tracks that a farm can carry, which are
  the Python packages and the R packages. A store never carries an interpreter,
  thus no store changes the R version, the Python version, or the Node version.

The [README](./sandbox-base/README.md) of `sandbox-base` documents the exec
protocol, the transport modes, and the egress firewall — the security-relevant
machinery. Read it before you change anything under `sandbox-base/`.

## Getting the image

The published image is a multi-arch manifest, thus `docker pull` resolves your
architecture automatically:

```sh
docker run --rm -v /path/to/store:/mnt/libs:ro \
  ghcr.io/inflexa-ai/sandbox-base:latest \
  python3 -c "import scanpy; print(scanpy.__version__)"
```

The image publishes to `ghcr.io/inflexa-ai/sandbox-base`, tagged `latest` and
`<date>-<sha>`.

The resolver env is baked in, thus a plain `docker run` with a store mounted and
**no harness** resolves an import and answers `list_available_packages` (which
reads `/mnt/libs/current/packages.txt`).

| Env var | Points at | So that |
|-|-|-|
| `INFLEXA_LIB_ROOT` | `/mnt/libs/current` | one source of truth for the store location |
| `R_LIBS_SITE` | the three `r/` subtrees of the store | `library("X")` resolves against the store |
| `NODE_PATH` | `/opt/node/node_modules` | `require("X")` resolves against the image |
| `PATH` | it carries `/opt/conda/bin` last | a bioconda command-line tool resolves, and the system `python3` stays the default |

`PYTHONPATH` is not set. System Python resolves the store through the `.pth` file
that the image writes.

## Extending the package set

Use the host provisioner:

```sh
inflexa store add <package>
```

The provisioner writes into the store that the sandbox mounts. A `FROM` image that
installs a package at `/mnt/libs/current` is **not** a supported extension path: a
store mounts read-only over `/mnt/libs`, thus it shadows each such package.

**The published image ships no build toolchain.** It is deliberately lean.

## The library store manifest

[`lib-store-manifest.yaml`](./lib-store-manifest.yaml) is the **single
package-set source of truth**. Add a package there, never in a Dockerfile.

It pins the runtime versions (`r_version`, `python_version`, `base_image`) and
lists packages by **track**:

| Track | Holds | Built by |
|-|-|-|
| `r.cran` | CRAN packages. A transitive CRAN dependency of a Bioconductor package is listed **explicitly**. | the provisioner, into the store |
| `r.bioconductor` | Bioconductor packages. | the provisioner, into the store |
| `r.github` | R packages from GitHub (`owner/repo`). | the provisioner, into the store |
| `python.pip` | Python packages, under `common` (each arch) plus an optional per-arch list. | the provisioner, into the store |
| `node` | Node packages — a flat list, not arch-split. `echarts` backs the chart and report rendering. | the image, at `/opt/node` |
| `system_tools` | Bioinformatics command-line tools from bioconda, split `common` (each arch) / `amd64` (a tool with no linux-aarch64 bioconda package). | the image, at `/opt/conda` |

`base_image` must match the `BASE_IMAGE` build arg of `sandbox-base`. The runtime
and the store then build against the same R and the same Python. Thus each
compiled extension of the store matches the ABI of the runtime.

Build-time dependencies (compilers, `-dev` headers) are **not** in the manifest.
They live in the builder stages, through
[`install-build-toolchain.sh`](./install-build-toolchain.sh). The runtime system
libraries live in `sandbox-base/Dockerfile`.

## Architecture support

The image publishes for `linux/amd64` and `linux/arm64`.

The amd64 build needs a large self-hosted runner (`inflexa-builder`).

## Building locally

Build from the **repo root**, because the Dockerfile `COPY`s
`images/lib-store-manifest.yaml`:

```sh
docker build -f images/sandbox-base/Dockerfile \
  --build-arg BASE_IMAGE=rocker/r-ver:4.6.0 \
  -t sandbox-base:local .
```

[`scripts/build-libs-local.sh`](../scripts/build-libs-local.sh) does the same
build, and it can also extract the per-track tarballs.

The conda track and the Node track install in throwaway `*-builder` stages. Each
one runs a best-effort **load check**: a tool or a package that does not resolve is
dropped from its fragment, and a track that resolved zero entries fails the build.
The runtime stage then copies the finished prefix in, thus no build toolchain
reaches the published image.

## Contributing

- **A package** belongs in [`lib-store-manifest.yaml`](./lib-store-manifest.yaml),
  not in a Dockerfile.
- **Keep the runtime stage lean.** Build tooling (compilers, `-dev` headers)
  belongs only in a `*-builder` stage.
- **A change under `sandbox-base/`** touches the containment boundary — the exec
  protocol, the signed endpoints, the egress firewall. Read
  [`sandbox-base/README.md`](./sandbox-base/README.md) and
  [`SECURITY.md`](../SECURITY.md) first, run `go test ./...` inside
  `sandbox-base/server/`, and name anything that loosens the isolation.
