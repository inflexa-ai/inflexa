# Tasks — poll transport mode

Reworks the `fix/sandbox-credential-isolation` branch / PR #47. Keep the security
core (B2/B3/hardening/signed GET); replace the gateway with two transport modes.

## 1. Spec

- [x] Finish spec deltas for `harness-sandbox-exec`, `sandbox-server`, `docker-sandbox-provider`
- [x] `openspec validate add-poll-transport-mode --strict` passes
- [ ] Radu reviews the change before implementation

## 2. sandbox-server (Go) — poll mode + firewall

- [x] Add a bounded per-exec **event ring buffer** to the exec table (`exectable.go`): append event, snapshot `events since cursor`, high-water cursor, `truncated` flag on drop-oldest
- [x] `GET /exec/{execId}?since={cursor}` (`main.go`): return signed `{ status, events[], cursor, result? }`; `since` absent → from 0; still-running → no `result`; keep the existing signature construction over the full body
- [x] `SANDBOX_TRANSPORT` config (`config.go`): `poll` (default) | `callback`; in `poll`, do not construct/require `CORTEX_BASE_URL` or the `callbackClient`; in `poll`, executor appends events to the ring instead of POSTing them
- [x] Callback mode unchanged (POST event/complete), guarded on `SANDBOX_TRANSPORT=callback`
- [x] Root **egress-firewall entrypoint** for Docker poll mode (`sandbox-entrypoint.sh`): install `iptables OUTPUT DROP` (allow `lo` + `ESTABLISHED,RELATED`), `setpriv`-drop caps + uid to 1000, exec sandbox-server. Gate on `SANDBOX_EGRESS_FIREWALL` set by the Docker provider (not K8s)
- [x] Bake `iptables` into `images/sandbox-base` (Dockerfile) + copy the entrypoint
- [x] Delete `gateway.go` and its tests
- [x] Go tests (`poll_test.go`): ring buffer (append/since/truncate), `?since` handler (signed, incremental, terminal, unsigned→401), poll-mode executor buffers instead of posting; callback-mode still posts (`executor_test.go`)

## 3. Harness (TS) — poll loop + provider

- [x] `SandboxTransport` + poll event/response types in `sandbox/types.ts`
- [x] `await-exec.ts`: poll-mode loop (no `DBOS.recv`/topic) — durable steps named `sandbox.poll-exec-result.${execId}.${n}`, advance cursor, `emit` new events, return on terminal `result`; verify the signed body as today; keep callback-mode `recv` loop (`awaitExecCallback`) with pull as its backstop; `awaitExec` dispatches on transport
- [x] `docker-client.ts`: removed gateway container + `--internal` network lifecycle; poll mode → default bridge + `127.0.0.1:{port}` published + `CapAdd: ["NET_ADMIN"]` + `SANDBOX_EGRESS_FIREWALL` + root user (entrypoint drops); pass `SANDBOX_TRANSPORT`; `isAlive` is the container-only check
- [x] Thread `SandboxTransport` through `create-sandbox.ts` (default `poll`) into the docker + k8s ops and `awaitExec`; `k8s-client.ts` sets `SANDBOX_TRANSPORT` pod env (NetworkPolicy is its poll confinement)
- [x] Rewrote `docker-client.test.ts` for the no-gateway topology (the SandboxClient fakes need no change — `awaitExec`'s signature is unchanged)
- [x] TS tests: poll loop returns on terminal, forwards incremental events, replay-stable step names, forged poll response hard-cancels, deadline times out; dispatch (poll default vs callback); callback recv loop unchanged

## 4. CLI (embedder)

- [x] `SANDBOX_TRANSPORT = "poll"` const at the composition root (`runtime.ts`), threaded into `createSandboxClient`
- [x] Boot binds no ingress in poll mode: `noopExecIngress()` instead of `startIngress()`; empty `cortexBaseUrl`
- [x] `cli/openspec` delta for the boot-seam / ingress change (`harness-runtime` MODIFIED)
- [x] CLI `tsc` clean (0 errors after `bun install`); harness `tsc` clean

## 5. Docs

- [x] `SECURITY.md`: two modes + the poll-mode egress firewall; "the sandbox initiates nothing" for poll
- [x] `harness/CLAUDE.md` + `CONTEXT.md`: architecture diagram, transport glossary, endpoint list (`?since` cursor), no gateway
- [x] `images/sandbox-base/README.md`: endpoints + transport modes + firewall entrypoint
- [ ] Close #27 and #41 with a comment pointing at the mechanism (at land time)

## 5b. Review hardening (PR #47 review round)

- [x] Poll loop: newer-than-cursor filter applied client-side (replayed signed snapshots cannot duplicate events)
- [x] Poll loop: seq-gap detection surfaces ring-shed events via an advisory warn (injectable, defaults to `DBOS.logger.warn`)
- [x] Poll loop: one final poll upon crossing the deadline before `ExecTimeoutError` (parity with the callback loop's deadline pull)
- [x] Poll loop: two-phase attempt-derived cadence (1.5s × 40 attempts, then 10s) to bound DBOS step-row growth on long execs
- [x] sandbox-server: fatal startup refusal when `SANDBOX_EGRESS_FIREWALL=1` but euid is 0 (entrypoint drop bypassed)
- [x] Entrypoint: `ip6tables` mirror of the egress deny when the container has an IPv6 stack
- [x] Stale gateway topology text purged from `PULL_REQUEST_TEMPLATE.md`, `CONTRIBUTING.md`, `inbound_auth.go`; `SECURITY.md` reachability claims qualified per mode

## 6. Verify

- [x] `bun test src/sandbox` (147 pass) + `tsc` green; `go test ./...` (ok) + `gofmt` green (changed files)
- [ ] E2E against the real image — **poll mode**: needs a sandbox-base image build + Docker (firewall mechanism already spike-verified 2026-07-08)
- [ ] E2E — **callback mode**: submit → pushed events/complete verified (Docker Desktop)
- [x] Cross-language HMAC for the `?since` body: same `signCallback` construction over the body, proven equivalent earlier; both sides' unit tests sign/verify the poll body

## 7. Land

- [x] Rework the branch (deleted gateway, added modes); commits signed off, no AI trailer
- [ ] Force-push; update PR #47 body to the two-mode design (pending Radu)
- [ ] `openspec archive add-poll-transport-mode` (harness + cli) after merge
