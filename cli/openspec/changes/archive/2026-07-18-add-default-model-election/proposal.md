# Add Default Model Election

## Why

Issue #144: in cliproxy mode the default chat model is picked non-deterministically — `pickDefaultModel` takes the first `/v1/models` id containing the preferred family substring, and the proxy's serving order shuffles between calls. Worse, the proxy's list is sourced from a GitHub registry, not from what the OAuth credential can actually serve, so the pick can land on a model that answers 404 — producing a chat session where every turn fails (~1 launch in 6–12 on an affected account) and a launch probe that cannot verify a perfectly healthy credential. The #142 probe already observes the 404 at launch and discards the verdict; the fix is to stop discarding it.

## What Changes

- **Deterministic recency ranking**: the proxy `/models` response's `created` timestamps (verified live: passed through from the registry) replace serving order — candidates within the preferred family rank newest-first. Same list ⇒ same rank, always.
- **Model election primitive**: one shared mechanism — rank candidates by recency, validate accessibility with the free, unbilled `count_tokens` request (verified live: the proxy routes it upstream with the real credential; inaccessible models 404 identically to completions), walk to the first survivor. The survivor becomes the cached auto default that chat boot consumes.
- **The launch probe elects instead of reporting**: a 404 on the top candidate advances the walk rather than warning "not verifiable". The probe's final credential verdict remains the existing bounded completion POST. The probe additionally validates an explicit model pin and **warns (never blocks)** when a pin has gone stale upstream.
- **Setup gains a default-model step**: after login/probe, a select prompt listing accessibility-validated models with a preselected **Auto** row (labeled with the currently elected model). Accepting Auto writes nothing — the default stays adaptive. Explicitly choosing a model writes `models.agents.*` for both agents (a deliberate pin). No hardcoded model ids anywhere.
- **Picker accessibility validation**: the TUI agent-model picker validates a selection on commit (count_tokens) and surfaces an inaccessible model as an in-dialog error instead of persisting a 404ing pin; the listed models are badged/filtered by accessibility where the listing supports it.

## Capabilities

### New Capabilities

- `default-model-election`: the deterministic, validated election of a default model from a live model list — recency ranking, count_tokens accessibility validation with completion-POST fallback, the candidate walk, and the process-cache semantics of the elected winner.

### Modified Capabilities

- `model-connection`: the cliproxy auto-default requirement changes from "the proxy `/models` default ranking" (order-dependent first match) to the deterministic elected candidate; the setup flow gains the default-model selection step with Auto-vs-pin semantics.
- `agent-model-selection`: the connection's mode default becomes the elected model; the picker gains commit-time accessibility validation and the Auto/pin distinction (explicit setup pick writes both agent keys).
- `cliproxy-credential-health`: the launch probe's model input changes from "the resolved default model" to the election walk (a 404 advances candidates instead of terminating as `unobservable`); adds the stale-pin warning.

## Impact

- `cli/src/modules/proxy/models.ts` — schema widens to `{ id, created }`; `pickDefaultModel` becomes the ranked-candidates primitive; election + validation live here (cliproxy-owned concerns).
- `cli/src/modules/infra/setup.ts` — `probeOnce`/`ensureLiveCredential` consume the election walk; the setup flow gains the model-selection prompt.
- `cli/src/modules/harness/model_listing.ts` / the TUI picker commands — accessibility validation on commit; badge/filter support.
- `cli/src/modules/harness/runtime.ts` — no resolution-order change; `resolveDefaultModel` consumes the elected id through the existing seam and cache.
- No config-schema change: `models.agents` already carries pins; Auto writes nothing.
- No new dependencies. Network cost: zero on the happy path (count_tokens is unbilled; the walk adds requests only when a candidate 404s).
