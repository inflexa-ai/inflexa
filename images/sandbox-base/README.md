# sandbox-base

## Overview

The **one runtime image** of every sandbox. It bundles the language runtimes
(R 4.6.0, Python 3.12, Node.js 24), the bioconda command-line tools at
`/opt/conda`, the Node packages at `/opt/node`, and Chromium. It also carries
a Go **sandbox-server**, the in-container counterpart to the harness
`SandboxClient`: the client submits a command and polls for its result, and
the server runs the command. See
[`../../harness/CONTEXT.md`](../../harness/CONTEXT.md) and the
[`sandbox-server`](../../harness/openspec/specs/sandbox-server/) /
[`harness-sandbox-exec`](../../harness/openspec/specs/harness-sandbox-exec/)
specs for the protocol.

`sandbox-base` bakes **no** analysis package. The packages come from the
**package store**, mounted read-only at `/mnt/libs`. The farm of the
analysis mounts at `/mnt/libs/farm`, and its optional read-write cache at
`/mnt/libs/cache`. The image advertises its two owned tracks (the conda
tools and the Node packages) through the baked record at
`/opt/inflexa/image-packages.json`. The record carries the identity of the
image, the runtime versions, and the version of each tool and each package.
The catalog build copies the same file into the store root. Thus
`list_available_packages` reads it at `/mnt/libs/image-packages.json`, and it
merges the record with the `inflexa.lock` of the mounted farm.

The sibling image, [`../sandbox-provisioner`](../sandbox-provisioner), is
the network-enabled builder that writes the store. The two images build from
one digest-pinned base and publish together
([`.github/workflows/sandbox-images-build.yml`](../../.github/workflows/sandbox-images-build.yml)).
See [`../README.md`](../README.md) for the store, the manifest, and the
local builds.

## What's here

|Path|Role|
|-|-|
|`Dockerfile`|Multi-stage build: compiles the server + provenance shim, builds the conda prefix and the Node tree in builder stages, then assembles the runtime image on `BASE_IMAGE`.|
|`scripts/`|The manifest readers and the node load check. The builder stages run them in place of inline programs.|
|`server/`|The Go `sandbox-server` (static binary, `CGO_ENABLED=0`) — the HTTP exec protocol.|
|`provenance/`|File-read tracking hooks: `provtrack.c` (LD_PRELOAD), `sitecustomize.py` (Python), `Rprofile.site` (R).|
|`sandbox-entrypoint.sh`|Seeds the prepared caches, installs the egress firewall, drops privileges, execs the server.|
|`inflexa-seed-caches.sh`|The `seed_caches` function, at `/usr/local/lib/` in the image. The entrypoint sources it, and the cache check of the build sources the same file.|

## Exec protocol

The server listens on `:8765` (override `SANDBOX_SERVER_PORT`) and exposes:

- `GET  /health` — the readiness probe.
- `POST /exec` — submit a command. The server sends `202` immediately and runs the command in the background.
- `GET  /exec/{execId}?since={cursor}` — the poll. It sends `{ status, events[], cursor, truncated?, result? }`. If `since` is not there, the server uses `0`.
- `GET  /preview/...` — static file preview, only when `PREVIEW_ROOT` is set (the shipped image never sets it).

The `status` is `running`, `completed`, or `failed`. The `events` are the
progress events after the `cursor` of the request. A bounded ring for each exec
holds them. The `result` is the terminal result, with the provenance frame. It
is in the poll only after the exec ends. Thus the host reads the end of the
exec from `result`.

The `execId` is the key of the exec record. A submit with a known `execId` sends
the stored status, and the command does not run again. The server keeps each
record in memory for the life of the process. There is no `kill` route.

## Confinement

The endpoints carry no credential. The network is the boundary:

- Docker publishes the port on `127.0.0.1` only. The entrypoint of each sandbox
  always installs the egress firewall. Thus a sibling sandbox on the same bridge
  cannot open a connection to this server.
- K8s confines the pod with a NetworkPolicy.

The server never opens an outbound connection. The host polls, and the sandbox
starts nothing.

## Entrypoint: the cache seed, then the firewall

`sandbox-entrypoint.sh` sources `inflexa-seed-caches.sh` and calls `seed_caches`
before the firewall path and before the exec. When the read-write cache mount
at `/mnt/libs/cache` is present, the seed does nothing — the env of the mount
plan already points into it. Without the mount, the seed copies `numba-cache`
and `matplotlib_config` from the farm to writable paths under `/tmp`. The
copy is necessary because numba selects a cache directory by a write probe,
and it skips a read-only one. A missing cache degrades in silence: a cold
cache costs time, not correctness.

## Egress firewall (Docker)

The sandbox needs no egress. The Docker backend always sets
`SANDBOX_EGRESS_FIREWALL=1` and grants `CAP_NET_ADMIN`. Before the workload
runs, the root entrypoint of the image installs these rules:

```
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -P OUTPUT DROP
```

Then `setpriv` drops to uid 1000 with an empty capability set. Thus the
workload cannot open a new outbound connection, and it cannot flush the rules.
The inbound poll of the host uses the established connection. Thus the poll
works while egress is blocked. `lo` stays open for local tooling.

If the flag is not set, the entrypoint execs the server directly. K8s uses this
path, because a NetworkPolicy confines the pod. There is no gateway sidecar.

## Build

Build from the **repo root** (the Dockerfile `COPY`s `images/sandbox-base/...`
and the manifest):

```sh
docker build -f images/sandbox-base/Dockerfile \
  --build-arg BASE_IMAGE=rocker/r-ver:4.6.0 \
  -t sandbox-base:local .
```

`BASE_IMAGE` is an `ARG` and must match `base_image` in
[`../package-store/manifest.yaml`](../package-store/manifest.yaml) — the
sandbox runtime and the package store build against the same R/Python.
[`.github/workflows/sandbox-images-build.yml`](../../.github/workflows/sandbox-images-build.yml)
builds and pushes this image and the provisioner to GHCR.
[`../../scripts/sandbox-images-build-local.sh`](../../scripts/sandbox-images-build-local.sh)
reproduces the pair locally.

## Contributing

- **server/** — run `go test ./...` inside `server/` before sending changes.
- **provenance/** — the LD_PRELOAD shim is compiled with
  `gcc -shared -fPIC -O2 -pthread -o provtrack.so provtrack.c -ldl`; the Python and
  R hooks load via `sitecustomize.py` and `R_PROFILE` respectively.
- **Runtime R/Python packages do NOT belong in the Dockerfile.** They live in
  the package store mounted read-only at `/mnt/libs`. Keep the image to the
  system libraries, the two image-owned tracks, and the tooling.
