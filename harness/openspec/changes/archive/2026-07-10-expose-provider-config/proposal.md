## Why

The harness already owns a provider-agnostic configuration type — `AiSdkProviderConfig`
(`src/providers/ai-sdk.ts`), a discriminated union over the `anthropic` and `openai-compatible`
kinds carrying endpoint/key/model — and its spec (`ai-sdk-provider-runtime`) promises that
embedders supply "endpoint/key/model configuration" at assembly. But the curated barrel exports
only the Anthropic compat wrapper (`createAnthropicProvider`); the general configuration path
(`createConfiguredAiSdkProvider`, `AiSdkProviderConfig`) is reachable only via the deep subpath
`@inflexa-ai/harness/providers/ai-sdk.js`. An embedder that lets its user choose any provider
(the cli's model-connection work, driven by PR #70's provenance gap) cannot do so through the
package's front door. Per the monorepo boundary rule, provider selection is a harness-owned
capability — the surface must be public before any embedder builds on it.

## What Changes

- Export the provider configuration surface from the curated barrel: the config union
  (`AiSdkProviderConfig`) and the factory that realizes it (`createConfiguredAiSdkProvider`),
  alongside the existing `createAnthropicProvider` (which remains, as a thin convenience over the
  `anthropic` kind).
- Document the front-door contract on the exported types: one `ChatProvider` per configured
  model (the wire model is baked in at construction; `ChatRequest` carries no model field), so an
  embedder needing N seat models builds N providers over one shared connection config.
- No behavior change inside the providers: construction, capability advertisement, and error
  classification are untouched.

## Capabilities

### New Capabilities

_None — this promotes an existing internal surface to the public contract of an existing
capability._

### Modified Capabilities

- `ai-sdk-provider-runtime`: gains the requirement that the provider configuration path
  (config union + factory) is part of the package's curated public surface — an embedder SHALL
  be able to construct a provider of either kind without deep-subpath imports.

## Impact

- `harness/src/index.ts` — barrel exports.
- `harness/src/providers/ai-sdk.ts` — JSDoc on the newly public types (contract documentation
  only; no logic change).
- Embedders: additive — existing `createAnthropicProvider` imports keep working. The cli's
  follow-up change (`configure-model-connection`, in `cli/openspec`) consumes the new exports.
