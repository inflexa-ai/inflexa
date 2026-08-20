# sandbox-base

## Overview

The **one runtime image** of every sandbox. It bundles the language runtimes
(R 4.6.0, Python 3.12, Node.js 24), the bioconda command-line tools at
`/opt/conda`, the Node packages at `/opt/node`, and Chromium. It also carries
a Go **sandbox-server**, the in-container counterpart to the harness
`SandboxClient`: the client submits work, and the server runs commands and
serves or POSTs HMAC-verified results. See
[`../../harness/CONTEXT.md`](../../harness/CONTEXT.md) and the
[`sandbox-server`](../../harness/openspec/specs/sandbox-server/) /
[`harness-sandbox-exec`](../../harness/openspec/specs/harness-sandbox-exec/)
specs for the protocol.

`sandbox-base` bakes **no** analysis package. The packages come from the
**package store**, mounted read-only at `/mnt/libs`. The farm of the
analysis mounts at `/mnt/libs/farm`, and its optional read-write cache at
`/mnt/libs/cache`. The image advertises its two owned tracks (the conda
tools and the Node packages) through the baked fragment at
`/opt/inflexa/image-packages.txt`, which `list_available_packages` merges
with the `inflexa.lock` of the mounted farm.

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
|`server/`|The Go `sandbox-server` (static binary, `CGO_ENABLED=0`) — HTTP exec protocol + signed results.|
|`provenance/`|File-read tracking hooks: `provtrack.c` (LD_PRELOAD), `sitecustomize.py` (Python), `Rprofile.site` (R).|
|`sandbox-entrypoint.sh`|Seeds the prepared caches, installs the poll-mode egress firewall, drops privileges, execs the server.|
|`inflexa-seed-caches.sh`|The `seed_caches` function, at `/usr/local/lib/` in the image. The entrypoint sources it, and the cache check of the build sources the same file.|

## Exec protocol

The server listens on `:8765` (override `SANDBOX_SERVER_PORT`) and exposes:

- `GET  /health` — readiness probe. Unauthenticated.
- `POST /exec` — submit a command; returns `202` immediately and runs it in the background. Signed.
- `GET  /exec/{execId}` — the terminal result for an exec, or `{"status":"running"}` while it is still executing. Signed. With `?since={cursor}` (poll mode) it returns `{ status, events[], cursor, truncated?, result? }`, always signed.
- `GET  /preview/...` — static file preview, only when `PREVIEW_ROOT` is set (the shipped image never sets it). Unauthenticated.

The exec endpoints are **signature-authenticated** in both transport modes: the
caller signs
`HMAC-SHA256(SANDBOX_CALLBACK_SECRET, "${execId}:${timestamp}:${sha256Hex(body)}")`
into `X-Sandbox-Signature`/`X-Sandbox-Timestamp` — the same construction the
served/pushed bodies use, run inbound — and the server verifies it against a
freshness window (`POST /exec` over the request body, `GET /exec/{execId}` over an
empty body). It is a request signature rather than a bearer on purpose: any
cleartext hop can drop a request but never mint one, whereas a static credential
would be reusable. A missing, forged, or stale signature is a `401`. Because the
check tests possession of the per-sandbox secret, a sibling sandbox — holding only
its own secret — cannot drive this one's `/exec`. There is no `kill` route.

## Transport modes

`SANDBOX_TRANSPORT` selects how a command's progress events and terminal result
reach the host. It changes nothing about execution, idempotency, provenance, or
inbound auth. `SANDBOX_CALLBACK_SECRET` is required in both modes.

**`poll`** (default) — the server never dials out; `CORTEX_BASE_URL` is neither
read nor required. Progress events accumulate in a bounded per-exec ring, and both
events and the terminal result are served, signed, from
`GET /exec/{execId}?since={cursor}`. The host polls; the sandbox initiates nothing.

**`callback`** — progress (`event`) and completion (`complete`) are POSTed to
`{CORTEX_BASE_URL}/sandbox/{execId}/{kind}` as HMAC-SHA256-signed callbacks,
retried with exponential backoff until a 2xx. **Each attempt is signed afresh**:
the host verifies the timestamp against a freshness window and treats a stale one
as fatal, so a signature minted once and reused would become permanently
unacceptable the moment that window elapsed. Delivery is push-first but never
push-only — the completion bytes are recorded before the POST, so
`GET /exec/{execId}` remains the signed-at-request-time recovery backstop for a
push that never lands.

Either way the served result bytes carry the provenance frame, so a pulled result
is indistinguishable from a pushed one.

## Entrypoint: the cache seed, then the firewall

`sandbox-entrypoint.sh` sources `inflexa-seed-caches.sh` and calls `seed_caches`
before the firewall path and before the exec. When the read-write cache mount
at `/mnt/libs/cache` is present, the seed does nothing — the env of the mount
plan already points into it. Without the mount, the seed copies `numba-cache`
and `matplotlib_config` from the farm to writable paths under `/tmp`. The
copy is necessary because numba selects a cache directory by a write probe,
and it skips a read-only one. A missing cache degrades in silence: a cold
cache costs time, not correctness.

## Egress firewall (Docker poll mode)

In poll mode the sandbox needs no egress. The Docker backend sets
`SANDBOX_EGRESS_FIREWALL=1` and grants `CAP_NET_ADMIN`; the image's root
entrypoint then installs, before the workload runs:

```
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -P OUTPUT DROP
```

and `setpriv`-drops to uid 1000 with an empty capability set, so the workload can
neither open a new outbound connection nor flush the rules. The host's inbound poll
rides the established connection, so polling works with egress hard-blocked; `lo`
survives for local tooling. When the flag is unset (callback mode, or K8s where
confinement is a NetworkPolicy) the entrypoint execs the server directly. There is
no gateway sidecar.

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
