# sandbox-base

## Overview

The single container image every analysis step runs in. It bundles the language
runtimes (R 4.6.0, Python 3.12, Node.js 20) plus a Go **sandbox-server** that is
the in-container counterpart to the harness `SandboxClient`: the client submits
work and receives results, while the server runs commands and POSTs HMAC-verified
callbacks back to the host. See [`../../harness/CONTEXT.md`](../../harness/CONTEXT.md)
and the [`sandbox-server`](../../harness/openspec/specs/sandbox-server/) /
[`harness-sandbox-exec`](../../harness/openspec/specs/harness-sandbox-exec/) specs
for the protocol.

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
- `POST /exec/{pid}/kill` — SIGTERM a running process (SIGKILL after a grace period).
- `GET  /preview/...` — static file preview, only when `PREVIEW_ROOT` is set.

Progress (`event`) and completion (`complete`) are POSTed to
`{CORTEX_BASE_URL}/sandbox/{execId}/{kind}` as HMAC-SHA256-signed callbacks
(`X-Sandbox-Signature`, `X-Sandbox-Timestamp`), keyed by `SANDBOX_CALLBACK_SECRET`,
and retried with exponential backoff until a 2xx.

## Build

Build from the **repo root** (the Dockerfile `COPY`s `images/sandbox-base/...`):

```sh
docker build -f images/sandbox-base/Dockerfile \
  --build-arg BASE_IMAGE=rocker/r-ver:4.6.0 \
  -t inflexa-sandbox-base .
```

`BASE_IMAGE` is an `ARG` and must match `lib-store-manifest.yaml`. **No CI job
builds this image** — build and push it by hand.

## Contributing

- **server/** — run `go test ./...` inside `server/` before sending changes.
- **provenance/** — the LD_PRELOAD shim is compiled with
  `gcc -shared -fPIC -O2 -pthread -o provtrack.so provtrack.c -ldl`; the Python and
  R hooks load via `sitecustomize.py` and `R_PROFILE` respectively.
- **Runtime R/Python packages do NOT belong in the Dockerfile.** They live in the
  external lib store mounted read-only at `/mnt/libs`; keep the image to system
  libraries and tooling only.
