## Context

Current wiring (verified in `docs/research_model_provider_selection.md` §5): one provider
construction site (`runtime.ts:444` — `createAnthropicProvider({ baseURL: env.cliproxyApiUrl,
token: proxyKey, model })`); `harness.model: string | null` where `null` auto-resolves from the
proxy's `/models` (`resolveModelId`/`pickDefaultModel`); a boot guard rejects non-Claude
auto-resolved ids because the route is Anthropic-shaped (`model_not_claude`); PR #70's provenance
identity derives the provider slug from the model family (`modelProvider()`), `TODO(extend)`-marked
to retire when provider+model become config. The harness front door exposes
`AiSdkProviderConfig`/`createConfiguredAiSdkProvider` (change `expose-provider-config`). The
`embedding` config block is the in-repo precedent for a mode-discriminated backend block. Settled
user decisions: D-ENV (config names selection, env supplies secret), D-FETCH (dynamic model
listing where possible), D-SHARE (one shared connection).

## Goals / Non-Goals

**Goals:**

- The chat backend (endpoint, protocol, provider identity, credential channel) is user-owned
  configuration; CLIProxy is one mode of it, not the frame.
- Provider identity is a configured fact end-to-end; no derivation from model-id substrings
  anywhere.
- Zero-config behavior identical to today.

**Non-Goals:**

- Per-seat model selection, palette switching, live swap (change `select-seat-models`).
- New provider protocols in the harness (its two kinds cover Anthropic + everything
  OpenAI-compatible).
- OAuth/API-key management for direct providers beyond the single env-var secret (no auth.json
  analogue yet; OpenCode-style credential store is future work).
- Embedding config (already decoupled; untouched).

## Decisions

**D1 — Config shape: a top-level `models` block with a `connection` object.**
`models.connection` is a mode-discriminated union mirroring the `embedding` precedent:
`{ mode: "cliproxy", provider? }` | `{ mode: "direct", provider, baseURL, protocol? }`. A new
top-level key (not more `harness.*`) because the connection is a cli-owned product concept that
outlives the harness block's grab-bag shape, and change `select-seat-models` extends the same
block with `models.seats`. Absent block ⇒ `{ mode: "cliproxy", provider: "anthropic" }` — today's
behavior verbatim. Rejected: extending `harness.*` (its schema is deliberately a cli-owned
grab-bag with `z.unknown()` at the top level; the connection deserves a first-class validated
home); a flat `modelConnection` key (blocks the seats extension).

**D2 — The provider slug is configured, never derived.**
Both modes carry `provider` (open string vocabulary, e.g. `anthropic`, `openai`, `google`). In
`cliproxy` mode, `inflexa setup` writes it from the authenticated account kind at login time
(`claude→anthropic, openai→openai, gemini→google, qwen→qwen, iflow→iflow` — a mapping that lives
ONLY in setup, where the account kind is a known fact, not an inference). In `direct` mode the
user states it. `modelProvider()` and its family table column are deleted;
`MODEL_FAMILIES`/`pickDefaultModel` survive only as the cliproxy ranking heuristic. Rejected:
keeping the derivation as a fallback — it is exactly the fabricated-provenance path this change
exists to kill; a missing provider is an actionable config error, not a guess.

**D3 — Protocol: explicit optional field, provider-implied default.**
`direct` mode accepts `protocol: "anthropic" | "openai-compatible"` (the harness's two kinds).
When absent: `provider === "anthropic"` ⇒ `anthropic`, else `openai-compatible`. Covers the
common cases with zero ceremony while keeping gateways expressible (e.g. an Anthropic-fronting
gateway that speaks OpenAI-compatible: `provider: "anthropic", protocol: "openai-compatible"`).
Rejected: protocol-only (loses the provider identity provenance needs); provider-enum-to-protocol
table (a closed vocabulary to maintain — the round-1 PR #70 mistake).

**D4 — Secrets: `INFLEXA_MODEL_API_KEY` in env only (D-ENV).**
Read in `lib/env.ts` (the sole `process.env` reader), consumed at provider construction, never
written to `config.json`, excluded from telemetry. `cliproxy` mode keeps its existing minted
client key (`readApiKey`). Missing key in `direct` mode ⇒ boot error naming the var. No URL env
var: the endpoint is config, authored by setup (research §6.4-1 — OpenCode collects no URL in its
connect flow either).

**D5 — Model resolution per mode.**
`cliproxy`: unchanged auto-resolve (`harness.model` override, else `/models` +
`pickDefaultModel`), with the guard generalized — the auto-resolved id must match the configured
provider's family, else `model_provider_mismatch` (replaces `model_not_claude`, same
actionable-error pattern; with the default provider `anthropic` this degenerates to exactly
today's Claude check). `direct`: an explicit model is REQUIRED (`harness.model` until
`select-seat-models` moves it into `models.seats`); no auto-resolve — direct users name their
model; missing ⇒ actionable boot error. Dynamic listing (D-FETCH) is a picker/UX concern for the
follow-up change, not a boot dependency.

**D6 — One construction path through the harness front door.**
Boot resolves `models.connection` to an `AiSdkProviderConfig` and calls
`createConfiguredAiSdkProvider` — for BOTH modes (`cliproxy` resolves to
`{ kind: "anthropic", baseURL: env.cliproxyApiUrl, apiKey: proxyKey, model }`, byte-equivalent to
the current wrapper call). One code path, no mode branching downstream of construction.
`RunEngineComposition.modelProvider` is fed from the connection config; the composed
`{provider}/{model}` provenance name is unchanged in shape.

## Risks / Trade-offs

- [Direct endpoints are unvalidated at config time] a typo'd baseURL surfaces at boot/first call →
  boot's existing fail-fast pattern (embedder probe precedent) applies: provider construction +
  first use fail with the endpoint in the error; no silent retry into the proxy.
- [`cliproxy` provider recorded at setup can go stale] (user re-authenticates a different account
  kind) → setup rewrites it on every successful login; a mismatch between configured provider and
  served models is caught by the D5 family guard with a remediation message.
- [Secret in env is visible to child processes] → same exposure class as the bio keys the cli
  already passes; documented on the env var; sandbox processes receive only what run deps
  explicitly pass (unchanged).
- [Spec text in `harness-runtime` says "local proxy" in three requirements] → all three MODIFIED
  in this change's deltas so archive-time sync stays truthful.

## Migration Plan

Purely additive config: absent `models` block ⇒ default connection reproduces today's behavior
(D1), so existing installs and tests continue unmodified. The provenance identity change is
observable only where `unknown/{id}` used to be recorded — after this change that case is a boot
error instead of a silent `unknown` record (strictly more honest; no stored documents rewritten).

## Open Questions

_None — the research doc's remaining opens either landed here (protocol selection: D3; env names:
D4; cliproxy slug: D2) or belong to `select-seat-models` (persistence of picks, dynamic listing
UX) / later work (registry-validated provider vocabulary)._
