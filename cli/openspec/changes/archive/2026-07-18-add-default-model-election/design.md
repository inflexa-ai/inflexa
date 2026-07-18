# Design: Default Model Election

## Context

Three verified facts (issue #144 + live verification against the running proxy, v7.2.77) drive this design:

1. `/v1/models` serving order is unstable, and `pickDefaultModel` (`proxy/models.ts`) takes the first family match in that order — the resolved default changes across launches.
2. The advertised list reflects the proxy's GitHub-sourced registry, not the credential: some ids answer `404 not_found_error` on use. The #142 launch probe observes that 404 and discards it — the poisoned pick stays in `cachedModelId`, which chat boot consumes via the shared cache (`runtime.ts` `resolveDefaultModel` → `seams.resolveModel` → the same memoized `resolveModelId`).
3. `POST /v1/messages/count_tokens` is routed by the proxy upstream with the real credential: inaccessible models 404 identically to completions, accessible ones return 200, and Anthropic does not bill it. `/v1/models` passes the registry's `created` unix timestamps through. Both verified live.

Fact 3 makes validation free and fast, which is what lets one mechanism serve the probe, setup, and the picker.

## Goals / Non-Goals

**Goals:**

- The same model list always elects the same default (deterministic rank).
- A model the credential cannot serve is never silently elected, pinned, or persisted.
- Zero added cost on the happy path; extra requests only when a candidate fails.
- One election primitive consumed by three surfaces: launch probe, setup step, TUI picker.

**Non-Goals:**

- No tier steering (e.g. "prefer sonnet"): a tier keyword list is a hardcoded id-shape list that ages like the registry does (`fable` matches no classic tier). Pure recency is the only rank with zero baked-in model knowledge; the "newest release is premium-tier" wrinkle is accepted — setup/picker pins are the escape hatch.
- No persistence of the elected winner: an auto-written pin recreates the staleness problem with none of the user's intent behind it. Auto stays adaptive.
- No picker-list badging/filtering by accessibility in this change: commit-time validation alone closes the "persist a 404ing pin" hole; live badge updates add TUI async complexity for UX sugar. Revisit separately.
- No change to the per-agent resolution precedence (`models.agents.<agent>` → `harness.model` → mode default), to direct-mode's explicit-model requirement, or to the third-party proxy.

## Decisions

### D1. Election lives inside `resolveModelId` — the probe consumes it, never pokes the cache

`proxy/models.ts` owns the election end-to-end: widen the zod schema to `{ id, created? }`, rank, walk candidates with `count_tokens`, cache the survivor. `probeOnce` keeps its shape (`resolveModelId` → `askProxy` completion POST) and inherits election for free through the existing call.

*Alternative rejected*: election in the probe with a models.ts cache-override seam — keeps `resolveModelId` dumb but requires cross-module cache mutation, and leaves probe-less chat paths (a process where the launch gate never ran) electing unvalidated. With `count_tokens` sub-second and unbilled, in-resolver validation is affordable on every path.

### D2. Rank = family preference, then `created` descending, then id ascending

`MODEL_PREFERENCE` family order (claude > gpt > gemini > qwen) is unchanged; within the matched family, sort by `created` desc; a missing `created` sorts as 0 (oldest); ties break by id asc so the rank is a total order. The no-family-match fallback also becomes recency-sorted (today: raw `ids[0]`). Never sort ids lexicographically as the primary key — ascending byte order puts dated legacy ids (`claude-3-5-…`) first, which would deterministically elect a confirmed-broken model on the reporting account.

### D3. Only a definite `not_found_error` advances the walk

The validation verdict is three-valued: 200 → elect; 404 → advance to the next candidate; anything else (timeout, 5xx, 429, network throw) → **inconclusive, elect anyway**. Walking on inconclusive would let a flaky network elect an arbitrary older model; this mirrors the probe's existing "only a definite rejection gates" policy. If every candidate 404s, elect rank[0] unvalidated — the probe's completion POST then surfaces the failure exactly as today (`unobservable` warn), preserving "the probe must never add a new way for launch to block".

Each validation round-trip is bounded by the caller's existing signal/timeout discipline (the probe already passes `AbortSignal.timeout`); the walk as a whole is bounded by list length.

### D4. `count_tokens` where the family is claude; skip validation otherwise

`count_tokens` is Anthropic-protocol and only verified through the proxy for claude-family ids. Non-claude families elect by rank alone (still deterministic — strictly better than today), and the probe's completion POST remains the universal credential verdict. The picker applies the same rule per connection protocol: `anthropic` protocol validates on commit; `openai-compatible` accepts as today (no cheap check exists).

### D5. Setup step: validated list, preselected Auto row, accept-writes-nothing

After login + probe, interactive setup presents a select prompt: first row **Auto — recommended: `<elected id>`** (preselected), then the connection-family models from `/v1/models`, accessibility-checked via a bounded-concurrency `count_tokens` sweep (models whose check is inconclusive are shown, not hidden — only a definite 404 excludes). Semantics:

- **Enter on Auto → write nothing.** The default stays `model: null` adaptive resolution — the user delegated the choice, and it keeps tracking releases.
- **Explicit pick → `writeAgentModel` for BOTH agents.** One question at setup; per-agent divergence stays a picker power feature. A pick is validated on commit (it came from the swept list, so normally pre-validated; free-text/inconclusive entries get the commit check).
- **Non-TTY setup → skip the step** (Auto). No hardcoded model ids anywhere in the flow.

*Alternative rejected*: silently persisting the elected id at setup — recreates pin-staleness without user intent (the option C analysis from the issue discussion).

### D6. Picker commit-time validation with in-dialog error

The TUI agent-model picker validates the chosen id on Enter (busy state while checking, per the existing dialog busy pattern): a definite 404 keeps the dialog open with an inline error naming the model and the account-accessibility cause; 200 or inconclusive commits as today. Applies to both the listed picks and the free-text fallback path.

### D7. Stale-pin warning at launch

The probe today validates only the auto default — an explicit pin is trusted (`runtime.ts` guard comment) even though chat will actually run on the pin. Extend the launch gate: for each distinct explicitly-pinned model (`models.agents.*`, `harness.model`) on an anthropic-family connection, run the free `count_tokens` check; a definite 404 **warns** with the pinned model, the failing agent(s), and the repick remedy — never blocks, never rewrites config. Auto-elected sessions are unaffected (election already validated).

## Risks / Trade-offs

- [`count_tokens` routing is fork-specific (verified on v7.2.77 only)] → D3's inconclusive-accepts policy means a proxy that stops routing it degrades to today's behavior (rank-only, deterministic), never to something worse; the completion POST remains the final verdict.
- [The proxy's failure mode for an inaccessible model is not stable] → observed live: after repeated 404s the proxy stops forwarding and answers `503 api_error` "auth_unavailable … cooldown" locally, which the verdict mapping reads as inconclusive. Accepted: a 503 must never advance the walk — the same shape appears transiently on perfectly served models (proxy boot, token refresh), and discriminating on the fork's internal message text is brittle. The residual exposure is a narrow, self-healing window (proxy in the learned/cooldown state AND the newest-ranked model inaccessible) where a broken candidate is elected; the probe's completion POST backstop still reports it, identical to the pre-change failure surface.
- [Recency elects a just-released premium/experimental model] → accepted per Non-Goals; visible in setup's Auto label; pin is one picker action away.
- [Setup's validation sweep hits upstream N times] → bounded concurrency, unbilled requests, inconclusive-include on failures; the sweep only runs in interactive setup.
- [Proxy injects a ~1400-token system prompt into `count_tokens`] → harmless (unbilled, no completion), noted so the reported token count is never treated as the user prompt's size.
- [Two callers race `resolveModelId` before the cache fills] → same as today: the runtime memoizes the promise (`cliproxyAutoDefault`), and a duplicate concurrent walk is idempotent — worst case a few extra free requests.

## Migration Plan

No config-schema or data migration: `models.agents` already exists, Auto writes nothing, and the change is launch-time behavior only. Rollback is a plain revert. The `models.ts` schema widening (`created` optional) is backward-compatible with proxies that omit the field — they degrade to id-ascending determinism within the family.

## Open Questions

None blocking. Deferred (tracked in Non-Goals): picker-list accessibility badging; re-evaluating `count_tokens` support for non-claude families through the proxy.
