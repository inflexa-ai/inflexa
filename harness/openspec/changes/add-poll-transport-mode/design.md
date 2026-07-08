# Design — poll transport mode

## The two modes, and who chooses

Transport is a harness capability, not a backend detail. The harness exposes
`SandboxTransport = "poll" | "callback"`; the embedder picks it at its
composition root and it rides to the container as `SANDBOX_TRANSPORT`. The same
backend (Docker or K8s) runs in either mode — the mode changes *how the terminal
result and progress events reach the host*, nothing else. The OSS/CLI default is
`poll`.

Why embedder-selected rather than per-backend or adaptive: it matches the
harness's "capability is harness-owned, values come from the embedder" rule, keeps
one code path per mode (testable), and lets an embedder still layer a per-backend
default on top if it wants. Adaptive fallback (try callback, fall back to poll)
was rejected as the most moving parts for the least benefit.

Inbound request signing (the B3 per-request HMAC on `POST /exec` and
`GET /exec/...`) is **mode-independent** — it authenticates the host→sandbox
direction in both modes and is what lets a sibling sandbox be network-adjacent yet
unable to drive this one's exec endpoints.

## Poll mode

- **sandbox-server never initiates a connection.** No `callbackClient`, no
  `CORTEX_BASE_URL`. Progress events are appended to a **bounded ring buffer** per
  exec (in the exec table). The terminal result is retained as today.
- **One cursor'd, signed endpoint.** `GET /exec/{execId}?since={cursor}` returns
  a signed `{ status, events: [...], cursor, result? }`: events newer than
  `cursor`, the new high-water cursor, and — once terminal — the completion
  `result` (with its provenance frame). The whole body is signed with the same
  `HMAC-SHA256(callbackSecret, execId:ts:sha256(body))` construction; the host
  verifies it exactly as it verifies a pulled result today. A single endpoint (not
  separate result/events endpoints) keeps it to one round-trip per poll and one
  signature/verification path.
- **`awaitExec` becomes a poll loop.** No `DBOS.recv`, no per-exec topic, no
  callback handler, no `DBOS.send`. The loop is a sequence of durable pull steps on
  a cadence (default ~1.5 s, tunable) named `sandbox.poll-exec-result.${execId}.${n}`
  — the unique-per-attempt naming and replay discipline already built for the
  recovery pull. It advances `cursor`, forwards new events via `emit`, and returns
  on the terminal `result`. Bounded by `step.timeout`. This is inherently
  restart-proof: a recovered workflow simply resumes polling from its current host
  identity (the #41 fix, now the primary path rather than a backstop).
- **The embedder starts no ingress.** `BootSeams.startIngress` is a no-op in poll
  mode; there is no host listener to be unreachable — which is what dissolves #27.

Event buffering note: the ring is bounded (drop-oldest with a `truncated` marker
surfaced to the host), because a chatty exec between polls must not grow unbounded.
Progress latency is one poll interval; acceptable for minute-to-hour analyses.

Dead-sandbox bound (accepted trade-off): the liveness watchdog's synthetic-complete
unblocks the `DBOS.recv` loop in callback mode, fast-failing a dead sandbox before
its deadline. The poll loop has no recv to unblock, so a dead sandbox in poll mode
is bound by `step.timeout` — the loop keeps polling an unreachable sandbox until the
deadline, then times out. The watchdog still marks the registry (the reaper cleans
up the machine), and correctness holds (the deadline is the backstop); only
fast-fail latency regresses. Making the poll loop liveness-aware (escalate to an
`isAlive` probe after N consecutive unreachable polls) is a clean follow-up, left
out here to keep the loop free of the topic/recv coordination poll mode exists to
avoid.

## Callback mode

Essentially the pre-gateway push path plus B2/B3/hardening: the sandbox is
*allowed* egress and POSTs signed event/complete callbacks to `CORTEX_BASE_URL`;
the embedder runs the ingress and `awaitExec` uses the `DBOS.recv` loop (with the
pull retained as its recovery backstop). No `--internal`, no gateway. On native
Linux the ingress-reachability caveat from #27 remains and is documented; on
Docker Desktop / K8s callback works as it does today.

## Confinement per mode and platform

The gateway existed only to reconcile a contradiction — callback (needs egress)
*and* `--internal` (no egress). Two modes remove the contradiction, so the gateway
goes.

| Mode | Platform | Inbound (host→sbx) | Egress block | Sidecar |
|---|---|---|---|---|
| poll | Docker (Desktop + Linux) | loopback-published port | in-container `iptables OUTPUT DROP` | none |
| poll | K8s | pod IP | NetworkPolicy | none |
| callback | Docker Desktop / K8s | — | egress *permitted* (scoped by NetworkPolicy on K8s) | none |
| callback | native Linux | — | permitted; ingress-reachability is the open caveat | none |

### The Docker poll-mode egress firewall (spike-verified)

`--internal` gives a hard egress block but also removes the published port, so it
cannot serve poll mode (the host could not dial in). The mechanism instead:

1. Container on the default bridge with the exec port published to `127.0.0.1`.
2. A **root entrypoint** holding `CAP_NET_ADMIN` installs, before any workload runs:
   ```
   iptables -A OUTPUT -o lo -j ACCEPT
   iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
   iptables -P OUTPUT DROP
   ```
   (optionally then drops `NET_ADMIN` from the bounding set), and execs
   sandbox-server, dropping to uid 1000.
3. New outbound connections are dropped; the reply path to the host's inbound poll
   is `ESTABLISHED`, so polling works; `lo` survives for local tooling.

Spike results on Docker Desktop (LinuxKit 6.12, aarch64), captured 2026-07-08:

| test | inbound | egress |
|---|---|---|
| default bridge + published port | `200` | OPEN |
| `--internal` + published port | `000` (unreachable) | blocked |
| bridge + published port + `OUTPUT DROP` (NET_ADMIN) | `200` | **BLOCKED** |

And the security properties held: egress stayed blocked even for root inside the
container, and a uid-1000 process could not flush the rules
(`iptables … Permission denied (you must be root)`) while loopback still worked.

Security trade-off: this adds `CAP_NET_ADMIN` (used only by the root entrypoint,
unreachable to the uid-1000 workload) in exchange for a hard egress block, versus
the alternative of staying `CapDrop: ["ALL"]` + uid-1000-throughout and accepting
best-effort egress on Docker. We take the hard block: it is a real control for a
capability untrusted code can never reach, and it makes the "sandbox initiates
nothing" claim literally true. The final workload posture is unchanged
(uid 1000, `no-new-privileges`, no effective caps).

## What is kept vs removed

**Kept** (the security core, already on the branch): `sanitizedEnviron` (B2),
inbound request signing (B3, both modes), container hardening, and the signed
`GET /exec/{execId}` — which *becomes* the poll primitive.

**Removed**: `gateway.go`; the gateway + `--internal` lifecycle in
`docker-client.ts`; the callback ingress in poll mode; the "Docker backend
confines the sandbox behind a gateway" requirement.

## Alternatives considered

- **Filesystem mailbox** (host and sandbox exchange command/result files over the
  shared bind mount, `--network=none`): maximal isolation and no network at all,
  and unlike the UDS spike it *would* cross the Docker Desktop VM boundary (regular
  file content syncs over VirtioFS). Rejected for now: it rewrites the protocol
  onto files with atomic-rename + poll-by-stat semantics, and K8s (pod IP) would
  keep HTTP — two transports. Worth revisiting if we ever want `--network=none`.
- **Bind-mounted Unix domain socket**: empirically disproved earlier — a socket is
  a kernel rendezvous, not file content, and does not cross the Docker Desktop VM
  boundary.
- **External egress block via `DOCKER-USER` iptables in the VM**: not cleanly
  reachable from the host CLI on Docker Desktop; the in-container approach is
  portable across Docker Desktop and native Linux.
