# Add poll transport mode (default), drop the gateway sidecar

## Why

The exec protocol makes the sandbox *push* its results back to the host over an
HMAC callback. On the Docker backend that push forced a per-analysis `--internal`
network plus a per-sandbox **gateway** sidecar to bridge the callback out — a
second container per sandbox whose only job is to intermediate a request the
sandbox could not otherwise send. It is the direct cause of two open defects:
**#27** (on native Linux the sandbox cannot reach the host callback ingress at
all, so every exec times out) and **#41** (a host that restarts mid-exec comes
back on a new ingress port, so the pushed callback lands nowhere and the run
wedges silently in `running`). Both are properties of *push*: results flow from
an address the sandbox cannot re-resolve.

Invert the direction and both dissolve. If the **host polls the sandbox** for
results instead of listening for a callback, the sandbox never initiates a
connection: there is no host ingress to be unreachable (#27), and the host always
dials from its *current* identity, so a restart cannot miss a result (#41). The
sandbox then needs no egress at all, so it can be *isolated* rather than
*bridged*, and the gateway's reason to exist disappears.

Callback stays available as an opt-in second mode for deployments that prefer
push — real-time progress, or many-sandbox scale with proper host networking. The
embedder chooses; the local CLI defaults to poll.

## What Changes

- **New `SandboxTransport = "poll" | "callback"`**, chosen by the embedder at its
  composition root and carried to the container as `SANDBOX_TRANSPORT`. Backends
  stay mode-agnostic; the OSS/CLI default is `poll`. The inbound signature check
  (per-request HMAC on `POST /exec` and `GET /exec/...`) applies in **both** modes.
- **Poll mode (new default).** sandbox-server never dials out. It buffers progress
  events in a bounded ring and serves a **signed** `GET /exec/{execId}?since={cursor}`
  → `{ status, events[], cursor, result? }` (the terminal-result signing already in
  place, extended to the incremental payload). `awaitExec` becomes a durable poll
  loop — no `DBOS.recv`, no per-exec topic — reusing the signed-pull verification
  and the unique per-attempt step names already in place. The embedder starts
  **no** callback ingress. **BREAKING** for the current push-only exec contract.
- **Callback mode (opt-in).** The pre-gateway push path, retained: the sandbox is
  *allowed* egress and posts signed callbacks to `CORTEX_BASE_URL`; the embedder
  runs the ingress. No `--internal`, so no gateway.
- **The gateway is removed** (`gateway.go`, its lifecycle and the `--internal`
  network management in `docker-client.ts`). In poll mode the Docker sandbox is
  confined by an **in-container egress firewall** instead: a root entrypoint
  holding `CAP_NET_ADMIN` installs `iptables -P OUTPUT DROP` (allowing `lo` and
  `ESTABLISHED,RELATED`), then drops the workload to uid 1000, which cannot alter
  the rules. Spike-verified on Docker Desktop — host polling works, egress is
  hard-blocked, loopback survives (see `design.md`). K8s uses NetworkPolicy.

Out of scope: callback-mode reachability on native Linux (#27's original
"bind the docker bridge gateway" proposal). Poll mode is the answer for local
Linux; callback mode on native Linux keeps that as a documented caveat until
separately addressed.

## Capabilities

### Modified Capabilities

- `harness-sandbox-exec`: adds transport-mode selection; `awaitExec` gains a poll
  loop and the terminal-result pull becomes the poll primitive (incremental
  events + cursor); inbound auth is stated to span both modes; the **gateway
  confinement requirement is removed** in favour of a mode-specific confinement
  requirement (poll: no egress; callback: egress permitted).
- `sandbox-server`: gains poll mode (event ring buffer + `?since` cursor endpoint,
  no outbound callbacks) alongside callback mode, selected by `SANDBOX_TRANSPORT`;
  gains a root egress-firewall entrypoint for Docker poll mode.
- `docker-sandbox-provider`: removes the gateway + `--internal` topology; adds the
  loopback-published port, the `CAP_NET_ADMIN` + iptables egress firewall, and
  transport-mode env wiring.

## Impact

- **Harness**: `sandbox/await-exec.ts` (poll loop), `sandbox/types.ts`
  (`SandboxTransport`, event/cursor types), `sandbox/docker-client.ts` (remove
  gateway/`--internal`; add published port + firewall opts + mode env),
  `runtime/assemble.ts` (transport dep). `submit-exec.ts` is unchanged (still
  signed). Deletes `images/sandbox-base/server/gateway.go`.
- **sandbox-server (Go)**: `main.go` (mode selection; the egress-firewall entry
  for Docker poll), `executor.go` / `exectable.go` (bounded event ring + cursor),
  the `GET /exec/{execId}` handler (serve incremental events + `?since`), skip the
  `callbackClient` in poll mode. Image bakes in `iptables`.
- **CLI (embedder, own spec tree)**: default `SANDBOX_TRANSPORT=poll`; the
  `BootSeams.startIngress` seam is a no-op in poll mode — `cli/.../ingress.ts` is
  not started, which is what actually closes #27. Spec deltas live in `cli/openspec`.
- **Docs**: `SECURITY.md`, `harness/CLAUDE.md` / `CONTEXT.md`,
  `images/sandbox-base/README.md` — replace the gateway/`--internal` story with the
  two-mode + egress-firewall story.
- **Closes** #27 and #41. **Reworks PR #47** (keeps its security core: B2
  `sanitizedEnviron`, B3 inbound auth, container hardening, the signed
  `GET /exec/{execId}`; removes the gateway).
