## Context

The launch gate (`ensureProxyReady` → `verifyCredentialAtLaunch` → `ensureLiveCredential`, `cli/src/modules/infra/setup.ts`) probes the managed CLIProxyAPI container before the TUI takes the terminal. Today three inputs produce the `unauthorized` verdict that drives a mandatory inline OAuth re-login: a 401 from the `/v1/messages` completion probe, a 401 from `/v1/models`, and an empty `/v1/models` list (`no_models`, `classifyModelResolution`). Verified against the proxy fork's source and a live stack:

- The proxy's listener answers before its async auth-file registration completes, so an answering proxy can serve an empty (or 200-but-not-yet-populated) model list during every cold start — including the restart the gate itself performs between re-login and re-probe. `retryWhileUnreachable` retries only connection-level silence, so this window is read as a verdict.
- One upstream 401 on the sole credential suspends its models out of `/v1/models` for 30 minutes (12 hours for 404-class results) while the on-disk credential remains valid and refreshable.
- A `/v1/models` 401 is produced by the proxy's client-API-key middleware alone; it never consults the provider credential, so a provider re-login cannot fix it — it means the key the CLI read from `config.yaml` is not the key the running proxy loaded (config drift across a boot).
- A served 503 with an `auth_unavailable` body means every loaded credential is temporarily blocked (cooldown after upstream errors) and recovers on its own; today it lands in the generic "could not verify" warning.

The re-login itself is unconditional: the first `unauthorized` verdict announces "expired or revoked" and enters the OAuth flow with no decline path; a second rejection fails the launch.

## Goals / Non-Goals

**Goals:**

- No forced OAuth from any transient or ambiguous proxy state; only a definite provider-side 401 may even *offer* a re-login, and the user can decline it.
- Every probe (first and post-bounce) waits, within the existing bounded budget, for the proxy to be *readable* — answering AND with auth registration landed — before any verdict is taken.
- Distinct, honest launch output per outcome: definite rejection, cooldown, ambiguous-empty, config-drift 401, outage.

**Non-Goals:**

- No changes to the proxy fork, its image pin, or its config surface (management API stays unused).
- No change to `default-model-election` semantics: an empty candidate list still elects nothing; only the launch gate's *interpretation* of it changes.
- No probing in `direct` mode (unchanged), no persistent health state, no mid-chat behavior changes (the chat auth banner mapping stays as is).

## Decisions

1. **The registration wait joins the existing retry loop rather than becoming a pre-step.** `classifyModelResolution`'s `no_models` maps to a new `ProbeAttempt` kind `not_ready`, and `retryWhileUnreachable` (renamed or extended in place) retries `not_ready` exactly like `unreachable`, under the same single budget. Rationale: the wait must cover every probe call site — first probe, post-bounce re-probe — and that loop is already the one seam both funnel through; a separate pre-poll would duplicate the budget and still leave the re-probe racing the bounce. Alternative rejected: waiting inside `composeRestartProxy`/`composeUp` (couples container plumbing to HTTP semantics and misses the cold first probe).

2. **Empty-at-deadline is ambiguous, not dead.** A list still empty when the budget expires yields a new `CredentialProbe` kind (`no_credential_loaded`-ambiguous) whose handling warns and proceeds, naming the two remaining causes — a credential file the proxy cannot load, or a temporary provider-side suspension — and the `inflexa setup --provider <name>` remedy. Trade-off accepted: the "corrupt credential caught at launch" scenario downgrades from forced login to actionable notice; the chat surface's auth mapping remains the backstop. Rationale: the gate cannot distinguish corrupt-file from 30-minute suspension, and forcing OAuth on a suspension both interrupts the user and churns a healthy credential.

3. **Only the completion probe's 401 is a credential rejection, and its re-login is a confirmable prompt.** `/v1/messages` 401 (a provider-side verdict, forwarded upstream) keeps gating — but on a TTY it now asks (clack confirm, consistent with setup's prompt idiom) before entering OAuth; declining proceeds to launch with a warning. Accepting runs the existing login → restart → re-probe cycle, whose re-probe now benefits from decision 1; a second definite rejection keeps today's hard error. Non-TTY behavior is unchanged (error naming the setup command). Rationale: a definite 401 after a *readable* probe is strong evidence, but the user may know better (e.g. they just fixed the account elsewhere), and consent was the missing piece of the UX.

4. **`/v1/models` 401 stops meaning "provider credential dead".** Verified: it is client-key middleware only. It now maps to `unobservable` with a warning naming the actual condition — the client key on disk does not match the running proxy — and `inflexa setup` (reprovision/restart) as the remedy. A re-login prompt here would demand OAuth that cannot fix the fault. Alternative rejected: auto-bouncing the proxy to reload the config — a state-changing surprise from a read path, and the drift's cause (which config the container mounted) deserves the setup flow's diagnostics.

5. **Cooldown gets its own classification via the 503 body.** `askProxy` (and the model-resolution path for a served 503) parses the anthropic-shaped error body; a message carrying the proxy's `auth_unavailable` marker yields a `cooling_down` probe kind → launch prints that the provider credential is cooling down after upstream errors and recovers on its own, then proceeds. The CLI already couples to a fork body discriminator for `count_tokens` 404s (`models.ts`, `not_found_error`), so this is the established pattern; an unrecognized 503 body degrades to today's generic warning — never worse than the status quo.

6. **One budget, existing constants.** The readiness wait reuses `PROXY_BOOT_BUDGET_MS`/`PROXY_BOOT_PAUSE_MS`; no new tunables. A healthy warm launch is byte-identical in behavior and latency (first probe answers non-empty immediately).

## Risks / Trade-offs

- [Corrupt credential no longer forces login at launch] → the ambiguous notice names the re-login command; chat's auth banner still catches the dead session in the first turn.
- [During a 30-minute suspension, every launch waits the full budget before the ambiguous notice] → bounded (~10s) and honest; preferable to OAuth churn. The notice wording says "may recover on its own" so users stop treating login as the fix.
- [Cooldown detection couples to a fork wire string] → prefix-match a single stable token (`auth_unavailable`); mismatch degrades to the generic warning path, which is today's behavior.
- [A genuinely revoked credential whose proxy also empties the list (post-refresh-401 latch) now reaches chat before failing] → the first turn surfaces the dedicated auth banner naming the re-login command; nothing is silently broken.

## Migration Plan

Pure CLI behavior change, no persisted state or config migration. Rollback = revert the commit.

## Open Questions

None blocking. Prompt/notice wording is settled at implementation time following the existing clack log idioms in `setup.ts` (not TUI surfaces, so the design gallery is not implicated).
