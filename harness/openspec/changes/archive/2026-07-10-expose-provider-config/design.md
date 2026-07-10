## Context

`AiSdkProviderConfig` (`src/providers/ai-sdk.ts:19-36`) is a discriminated union —
`{ kind: "anthropic", baseURL?, apiKey, model, … } | { kind: "openai-compatible", name, baseURL,
apiKey?, model, … }` — realized by `createConfiguredAiSdkProvider` (:154-172), which builds the
AI SDK `LanguageModel` (`createAnthropic(...).chat(model)` /
`createOpenAICompatible(...).chatModel(model)`) and wraps it in the `ChatProvider` seam. The
curated barrel (`src/index.ts`) exports only `createAnthropicProvider` (`providers/anthropic.ts`),
a thin wrapper over the `anthropic` kind. The seam's defining property: `ChatRequest` carries no
model field — the wire model is closed into the provider at construction (`providers/types.ts`).

The embedder-side driver is the cli's `configure-model-connection` change (see
`cli/docs/research_model_provider_selection.md`): users choose provider/model; the cli builds
providers from config. Its D-SHARE decision (one shared connection, per-seat models) maps onto
this seam as N provider instances over one connection config.

## Goals / Non-Goals

**Goals:**

- The provider configuration path is part of the package's public, curated surface.
- The construction contract (one provider per configured model; N seats = N instances over a
  shared connection) is documented where consumers read it (JSDoc on the exported types).

**Non-Goals:**

- Per-seat model support inside the harness (no `ChatRequest.model`, no seat registry) — the
  existing deps already accept a distinct `ChatProvider` per slot; instance multiplicity stays an
  embedder concern.
- New provider kinds, capability changes, or error-classification changes.
- Retiring the spec debt found during research (`agent-llm-config`, the `maxOutputTokens`
  requirement in `harness-providers` — both describe pre-AI-SDK code); tracked separately.

## Decisions

**D1 — Export the existing union verbatim; do not mint a new concept.**
`AiSdkProviderConfig` + `createConfiguredAiSdkProvider` become barrel exports as-is. Rejected: a
new harness-owned `ModelBackendConfig` wrapper type — it would be a rename with no added
semantics, and the union's `kind` discriminant already is the protocol-selection surface the
embedder needs. If a third kind ever lands, the union extends without another surface change.

**D2 — `createAnthropicProvider` stays.**
It is the existing public API with working embedder call sites; it remains as documented
convenience over `{ kind: "anthropic" }`. Rejected: deprecating it in this change — churn with no
consumer benefit.

**D3 — The per-seat contract is documentation, not API.**
The "N seat models = N provider instances over one connection" rule is stated in the exported
types' JSDoc. Rejected: a `createProvidersForSeats` helper — the embedder's seat set is
embedder-defined (the harness has no seat registry), so any helper would hard-code a consumer's
shape into the core.

## Risks / Trade-offs

- [Public-surface commitment] Exporting the union freezes its field names into the package
  contract → acceptable: the shape mirrors the AI SDK factories it feeds and has been stable
  since the AI-SDK rewrite; future kinds are additive union arms.
- [Misuse: one provider shared across seats needing different models] → mitigated by the JSDoc
  contract statement; the cli change's spec enforces correct wiring on the embedder side.
