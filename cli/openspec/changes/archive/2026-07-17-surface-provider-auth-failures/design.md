# Design — surface-provider-auth-failures

## Context

The provider OAuth credential lives at `<dataDir>/inflexa/cliproxy/auth/<provider>-<email>.json`, written once by the vendor login container and refreshed by the running proxy (`last_refresh` stamps confirm an 8h cadence — Anthropic's grant lifetime, not configurable). When refresh dies (revoked refresh token, network, vendor bug), nothing on disk records it: upstream documents `disabled` as operator-set, and no `last_error` is persisted. So the failure is only observable by making a request. Verified failure surface today: `isAuthenticated()` (`setup.ts:659`) passes on any non-dot entry — including the `logs/` subdirectory that provably sits beside the credential — and `ensureProxyReady`'s interactive re-login branch (`setup.ts:839`) therefore never fires; `inflexa setup` says "Already authenticated" (`setup.ts:135`); the chat banner shows the wrapped generic error (`conversation.ts:540`).

The port-8317 image (`eceasy/cli-proxy-api`) is a fork with no public source. Two behaviors relevant here are therefore unverified against it: the expired-credential HTTP status (assumed 401) and whether the running proxy hot-reloads a rewritten credential file (upstream has a file watcher). The design avoids depending on either.

## Goals / Non-Goals

**Goals:**

- No "looks ready, fails mid-work" trap: a dead credential is caught at TUI launch, where the terminal is still in normal stdio and the existing interactive login can run inline.
- Every remaining failure path names its remedy (the forced re-login command, or restarting the chat).
- The probe never *adds* a way for launch to fail: only a definite auth rejection gates.

**Non-Goals:**

- In-TUI re-auth dialog + automatic turn retry (follow-up; this change makes the mid-session failure legible and the relaunch self-healing).
- Probing in `direct` mode (the user's own key + endpoint; a probe would spend their tokens to validate configuration they own) or inside `inflexa setup` (the stack may not be up mid-setup; launch is the truth-teller).
- Making the vendor's refresh reliable, or owning the provider OAuth flow.

## Decisions

- **Probe at every TUI launch, cliproxy mode only.** Alternative considered: probe only before runs (cheaper). Rejected by product decision: chat is where the "I can start working" illusion bites — the user does something, it fails, and they must exit the TUI to re-login. The per-launch cost (one `max_tokens: 1` request, ~1-2s) is accepted.
- **Probe placement: inside `ensureProxyReady`, after `composeUp` succeeds** (the proxy container must be serving) and before the embedder gate. All launch entry points already funnel through `ensureProxyReady`/`ensureProxyReadyOrExit` (the chat-wiring "shared launch preamble"), so no caller changes.
- **Probe mechanics: reuse the existing proxy client surface.** `readApiKey()` parses the client key from the generated config; `resolveModelId(apiKey)` resolves the ranked default from the proxy's `/models` (served from proxy-local registry — verify at implementation that it answers without exercising the provider credential); then one minimal completion request against the proxy with `max_tokens: 1` and a bounded timeout (~10s). This exercises exactly the credential chat will use.
- **Failure policy — only a definite 401 gates:**
  - `401` + TTY → run the existing `authenticate()` flow inline, make the fresh credential observable to the running proxy, re-probe once; a second 401 fails launch actionably.
  - `401` + non-TTY → `ProxyError` naming `inflexa setup --provider <kind>`.
  - Anything else (4xx from a malformed probe, 429/5xx outage, timeout, connection refused) → log a warning and proceed. Rationale: a provider outage or slow container must not brick launch; the chat surface reports real failures with the auth mapping below.
- **Restart the proxy service after a probe-triggered re-login, before the re-probe.** The fork's hot-reload behavior is unverified; a compose restart of the proxy container is seconds, deterministic, and removes the assumption entirely. (The pre-existing fresh-login path needs nothing: there the login happens before `composeUp` starts the proxy.)
- **Static check stays permissive; the probe is authoritative.** `isAuthenticated` filters to `*.json`, treats `disabled: true` as unauthenticated, and treats an unreadable/unparseable JSON as *present* — a corrupt-but-maybe-fine file must not lock setup into re-login loops when the probe can decide for real. Never gate on `expired`: it goes stale every 8h by design and would force a spurious re-login after every setup.
- **Chat mapping detects the kind structurally.** A small cause-chain walker beside `describeCause` in `lib/cause.ts` (the module that owns "what failed" rendering across cli and harness error shapes) finds a `{ type: "auth" }` provider error at any depth. The banner names the configured provider (`models.connection.provider`, recorded at login by `recordCliproxyProvider`) and the remedies: restart the chat (the launch probe re-authenticates) or `inflexa setup --provider <kind>`. Falls back to generic rendering when the connection config carries no provider.
- **Setup wording stops asserting validity.** The already-authenticated branch says a credential *exists* and names the forced re-login flag — it cannot statically distinguish healthy from refresh-dead, so it must not claim to.

## Risks / Trade-offs

- [The fork may not answer the expired-credential case with 401 — then the probe's gate never fires for that case] → Behavior degrades exactly to today's (plus the hardened static check and honest messaging); the probe's warn-path logs the observed status, giving the real code to extend the gate with. Nothing regresses.
- [A 401 can also mean a wrong proxy *client* key (config drift), not a dead provider credential — re-login would not fix that] → Rare (the config and key are generated together and never rewritten); the re-probe-after-relogin failing a second time surfaces an error naming both possibilities rather than looping.
- [Per-launch probe latency (~1-2s) and one metered provider request] → Accepted explicitly; cliproxy-only keeps direct-mode users unaffected.
- [Probe races the proxy binary's startup right after `composeUp`] → The connection-refused/timeout branch warns-and-proceeds, so a cold-start race never blocks launch; the chat's auth mapping remains the backstop.

## Open Questions

- Whether `/models` on the fork answers without a healthy provider credential (assumed: served from local registry). If it does not, the probe simplifies: `resolveModelId` failing with 401 *is* the probe signal.

## Verification notes (observed live against `eceasy/cli-proxy-api:latest`)

Measured with a scratch container (own config, own auth dir, scratch port — the real credential untouched):

- **Expired credential whose refresh fails ⇒ HTTP 401** — reproduced with a fabricated credential file (past `expired`, bogus `refresh_token`): `401 {"error":{"type":"api_error","message":"auth_unavailable: no auth available (providers=claude, model=…)"}}`. The probe's gate and the harness `auth` classifier key on exactly the right signal; the open assumption in both designs is resolved.
- **Wrong proxy client key ⇒ HTTP 401** — the second 401 flavor is real, which is why the second-probe failure names both causes.
- **`/models` is credential-blind** — it serves the registry (200) with an empty list when no credential exists and the full model list when a dead credential exists. The open question above is resolved: the completion request stays the probe; the `/models`-401 fallback in the assembly is a harmless belt-and-suspenders.
- **No credential for the requested model's family ⇒ HTTP 502** (`unknown provider for model …`) — lands in the `unobservable` branch, correctly: that state is normally unreachable past the static presence check.
- **Healthy credential ⇒ HTTP 200** for the exact probe request shape (`x-api-key`, `anthropic-version`, `max_tokens: 1`), measured against the real proxy.
