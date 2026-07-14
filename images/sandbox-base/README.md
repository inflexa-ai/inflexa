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
baked in, no mount. All three publish to GHCR
(`ghcr.io/inflexa-ai/sandbox-{base,python,python-r}`) for `linux/amd64` and
`linux/arm64` via
[`.github/workflows/lib-store.yml`](../../.github/workflows/lib-store.yml). See
[`../README.md`](../README.md) for the image ladder, the manifest, and how to
extend or build the images.

## What's here

|Path|Role|
|-|-|
|`Dockerfile`|Multi-stage build: compiles the server + provenance shim, then assembles the runtime image on `BASE_IMAGE`.|
|`server/`|The Go `sandbox-server` (static binary, `CGO_ENABLED=0`) — HTTP exec protocol + signed callbacks.|
|`provenance/`|File-read tracking hooks: `provtrack.c` (LD_PRELOAD), `sitecustomize.py` (Python), `Rprofile.site` (R).|

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

## Egress firewall (Docker poll mode)

In poll mode the sandbox needs no egress. The Docker backend sets
`SANDBOX_EGRESS_FIREWALL=1` and grants `CAP_NET_ADMIN`; the image's root entrypoint
(`sandbox-entrypoint.sh`) then installs, before the workload runs:

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
