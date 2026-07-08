# sandbox-base

## Overview

The **lean base** of the three layered sandbox images. It bundles the language
runtimes (R 4.6.0, Python 3.12, Node.js 20) plus a Go **sandbox-server** that is
the in-container counterpart to the harness `SandboxClient`: the client submits
work and receives results, while the server runs commands and POSTs HMAC-verified
callbacks back to the host. See [`../../harness/CONTEXT.md`](../../harness/CONTEXT.md)
and the [`sandbox-server`](../../harness/openspec/specs/sandbox-server/) /
[`harness-sandbox-exec`](../../harness/openspec/specs/harness-sandbox-exec/) specs
for the protocol.

`sandbox-base` carries **no** analysis packages — its `/mnt/libs/current` is empty.
The analysis libraries are added by the two images that layer on top of it:

- [`../sandbox-python`](../sandbox-python) — `FROM sandbox-base` + the Python
  libraries, the bioconda CLI tools, and the Node package(s) (echarts).
- [`../sandbox-python-r`](../sandbox-python-r) — `FROM sandbox-python` + the R
  libraries.

Base stays lean deliberately: it is the image the **managed** service pulls per
node (a few hundred MB of conda tools would be a real cold-start tax), and it
mounts the per-track tarballs read-only over its empty `/mnt/libs`. An **OSS
user** instead runs `sandbox-python`/`sandbox-python-r` directly — the store is
baked in, no mount. All three publish to GHCR (`ghcr.io/inflexa-ai/inf-cli/*`)
for `linux/amd64` and `linux/arm64` via
[`.github/workflows/lib-store.yml`](../../.github/workflows/lib-store.yml).

## What's here

|Path|Role|
|-|-|
|`Dockerfile`|Multi-stage build: compiles the server + provenance shim, then assembles the runtime image on `BASE_IMAGE`.|
|`server/`|The Go `sandbox-server` (static binary, `CGO_ENABLED=0`) — HTTP exec protocol + signed callbacks.|
|`provenance/`|File-read tracking hooks: `provtrack.c` (LD_PRELOAD), `sitecustomize.py` (Python), `Rprofile.site` (R).|

## Exec protocol

The server listens on `:8765` (override `SANDBOX_SERVER_PORT`) and exposes:

- `GET  /health` — readiness probe.
- `POST /exec` — submit a command; returns `202` immediately and runs it in the background.
- `GET  /exec/{execId}` — the terminal result for an exec, or `{"status":"running"}` while it is still executing.
- `POST /exec/{pid}/kill` — SIGTERM a running process (SIGKILL after a grace period).
- `GET  /preview/...` — static file preview, only when `PREVIEW_ROOT` is set.

Progress (`event`) and completion (`complete`) are POSTed to
`{CORTEX_BASE_URL}/sandbox/{execId}/{kind}` as HMAC-SHA256-signed callbacks
(`X-Sandbox-Signature`, `X-Sandbox-Timestamp`), keyed by `SANDBOX_CALLBACK_SECRET`,
and retried with exponential backoff until a 2xx. **Each attempt is signed
afresh**: Cortex verifies the timestamp against a freshness window and treats a
stale one as fatal, so a signature minted once and reused would become
permanently unacceptable the moment that window elapsed.

Delivery is push-first but never push-only. The completion bytes are recorded
before the POST is attempted, and `GET /exec/{execId}` serves them **signed at
request time** — so a Cortex that was not listening when the exec finished can
still recover the result, with its provenance frame, whenever it comes back. A
still-running exec answers unsigned; the signature's presence is what marks a
response terminal.

## Gateway mode

`sandbox-server gateway` is a second program sharing this binary. It runs no exec
machinery, mounts nothing, and is never given `SANDBOX_CALLBACK_SECRET` — it
forwards TCP between two fixed destinations:

| env | meaning |
|---|---|
| `GATEWAY_INBOUND_PORT` (default `8765`) | listen; forwards to `GATEWAY_INBOUND_TARGET` |
| `GATEWAY_INBOUND_TARGET` | the sandbox's `host:port`, e.g. `sbx-abc123:8765` |
| `GATEWAY_OUTBOUND_PORT` (default `8766`) | listen; forwards to `GATEWAY_OUTBOUND_TARGET` |
| `GATEWAY_OUTBOUND_TARGET` | the Cortex ingress `host:port` |

The Docker backend puts each sandbox on a per-analysis `--internal` network,
which has no route to the internet, the LAN, or the host — and, because that also
removes published ports, no route *from* the host either. The gateway is what
restores both directions, one fixed hop each, and is the sandbox's only reachable
peer. Holding no secret, it can drop a completion but never forge one.

## Build

Build from the **repo root** (the Dockerfile `COPY`s `images/sandbox-base/...`):

```sh
docker build -f images/sandbox-base/Dockerfile \
  --build-arg BASE_IMAGE=rocker/r-ver:4.6.0 \
  -t inflexa-sandbox-base .
```

`BASE_IMAGE` is an `ARG` and must match `base_image` in
[`../lib-store-manifest.yaml`](../lib-store-manifest.yaml) — the sandbox runtime
and the library store are built against the same R/Python.
[`.github/workflows/lib-store.yml`](../../.github/workflows/lib-store.yml) builds
and pushes this image (and the two that layer on it) to GHCR on every change to
`images/**` or the manifest.

## Contributing

- **server/** — run `go test ./...` inside `server/` before sending changes.
- **provenance/** — the LD_PRELOAD shim is compiled with
  `gcc -shared -fPIC -O2 -pthread -o provtrack.so provtrack.c -ldl`; the Python and
  R hooks load via `sitecustomize.py` and `R_PROFILE` respectively.
- **Runtime R/Python packages do NOT belong in the Dockerfile.** They live in the
  external lib store mounted read-only at `/mnt/libs`; keep the image to system
  libraries and tooling only.
