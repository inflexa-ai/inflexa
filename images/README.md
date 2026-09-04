# Sandbox images

The container images that analyses execute in, and the manifest that decides
what the package store holds. Everything here builds from one package-set
source of truth — [`package-store/manifest.yaml`](./package-store/manifest.yaml).
[`.github/workflows/sandbox-images-build.yml`](../.github/workflows/sandbox-images-build.yml)
publishes the images, and
[`.github/workflows/package-store-build.yml`](../.github/workflows/package-store-build.yml)
publishes the store.

## The two images

Two images, two roles. No variant exists, and no image layers on another.

| Image | Role | Who runs it |
|-|-|-|
| [`sandbox-base/`](./sandbox-base) | The ONE runtime image: R 4.6.0, Python 3.12, Node 20, Chromium, the bioconda command-line tools at `/opt/conda`, the Node packages at `/opt/node`, and the Go `sandbox-server` that speaks the harness exec protocol. It bakes NO analysis package. | Every sandbox. The packages come from the package store, mounted read-only at `/mnt/libs`, with the farm of the analysis at `/mnt/libs/farm`. |
| [`sandbox-provisioner/`](./sandbox-provisioner) | The network-enabled builder. It holds the compilers, uv, pak, and an egress allowlist, and it writes the pool and the farms. It never sees user data. | The store build workflow, and the acquisition flights of the host (`inflexa store add`). |

The two images build from one digest-pinned base (`base_image` in the
manifest), and the provisioner build asserts that digest. A drift would give
compiled extensions a different ABI than the sandbox loads them with, thus
the assert fails the build.

`sandbox-base`'s own [README](./sandbox-base/README.md) documents the exec
protocol, the transport modes, and the egress firewall — the
security-relevant machinery. Read it before you change anything under
`sandbox-base/`.

## The package store

The store is a host directory with three parts:

- **the pool** (`store/`) — content-addressed, write-once directories, one
  per installed distribution.
- **the farms** (`farms/<analysis>`) — one symlink tree per analysis. A farm
  carries exactly one metadata file, `inflexa.lock`.
- **the graph** (`deps.json`) — the resolved dependency edges.

The store publishes to GHCR as an OCI artifact
(`ghcr.io/inflexa-ai/package-store`), one artifact per arch, with one zstd
layer per track. The CLI pulls it with ORAS (`inflexa store download`).

## Getting an image

Through the CLI, which starts the two image transfers as detached children:

```sh
inflexa sandbox pull      # the runtime image and the provisioner image
inflexa sandbox status    # references, presence, digests, transfer states
```

Or directly — the published images are multi-arch manifests:

```sh
docker run --rm ghcr.io/inflexa-ai/sandbox-base:latest \
  samtools --version
```

A bare `docker run` with no store mounted resolves the image-owned tools
only. The analysis packages arrive with the store mounts. The image bakes its
own inventory as the record at `/opt/inflexa/image-packages.json`, and the
catalog build copies that record into the store root. Thus
`list_available_packages` reads the record at `/mnt/libs/image-packages.json`,
and it merges the record with the `inflexa.lock` of the mounted farm.

## Adding a package

The `FROM` extension path is retired. The acquisition path is the extension
mechanism:

- **For your own analyses** — `inflexa store add <package>`. The provisioner
  installs it into the pool, and the farm of the analysis links it.
- **For the published catalog** — add an entry to
  [`package-store/manifest.yaml`](./package-store/manifest.yaml), never to a
  Dockerfile. A new entry takes the object form, with its `reason`.

## The manifest

[`package-store/manifest.yaml`](./package-store/manifest.yaml) is the intent
layer, validated by
[`package-store/manifest.schema.json`](./package-store/manifest.schema.json).
The build resolves it per arch, with hashes, and the workflow commits the
per-arch lock files (`package-store/lock.<arch>.json`) back to the
repository. Resolution obeys the manifest first and the lock second.

| Track | Holds |
|-|-|
| `python.pip` | Python packages, under `common` plus per-arch splits. |
| `r.cran`, `r.bioconductor` | The R packages that pak resolves as one lockfile. |
| `r.git`, `r.github` | Catalog-only pinned R sources. An acquisition refuses them. |
| `node` | The Node packages the IMAGE owns at `/opt/node`. |
| `system_tools` | The bioconda command-line tools the IMAGE owns at `/opt/conda`. |

An entry with `warm: warm/<package>.py` names its per-package warm script.
The preparation run executes each one against the catalog farm, and the
cache check replays the recorded workloads inside `sandbox-base`.

Build-time dependencies (compilers, `-dev` headers) are NOT in the manifest.
They live in [`install-build-toolchain.sh`](./install-build-toolchain.sh)
and the builder stages. Runtime system libraries live in
`sandbox-base/Dockerfile`.

## Architecture support

Published for `linux/amd64` and, best-effort, `linux/arm64`. The amd64 leg
is the primary target. On arm64 the R tracks compile from source, thus the
arm64 leg can fail without a red build. A load failure fails a leg on each
arch. No package ships that did not load. The builds need the large
self-hosted runners (`inflexa-builder`, `inflexa-builder-arm64`).

## Building locally

Build from the **repo root** — the Dockerfiles `COPY`
`images/package-store/manifest.yaml`:

```sh
scripts/sandbox-images-build-local.sh              # both images
scripts/sandbox-images-build-local.sh --base-only  # sandbox-base only
```

After a build, validate the runtime image or a store with
[`scripts/package-store-validate/run.sh`](../scripts/package-store-validate/run.sh),
and drive the provisioner with
[`scripts/package-store-check-provisioner.sh`](../scripts/package-store-check-provisioner.sh).

## Contributing

- **Packages** belong in the manifest, not in a Dockerfile. A new entry
  takes the object form, with its `reason`.
- **Keep the runtime image lean.** Build tooling belongs to the provisioner
  and the builder stages only.
- **Changes under `sandbox-base/`** touch the containment boundary — the
  exec protocol, the signed endpoints, the egress firewall. Read
  [`sandbox-base/README.md`](./sandbox-base/README.md) and
  [`SECURITY.md`](../SECURITY.md) first, run `go test ./...` inside
  `sandbox-base/server/`, and name anything that loosens isolation
  explicitly.
- **Changes under `sandbox-provisioner/`** touch the privileged half of the
  store: the one container with network and compilers. Keep the egress
  allowlist exact, and record a change to the privilege asymmetry.
