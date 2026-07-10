## Why

The chat backend is welded to CLIProxyAPI: the endpoint is a non-overridable constant
(`lib/env.ts`), the only provider construction site is `createAnthropicProvider` at that proxy URL
(`modules/harness/runtime.ts`), model identity exists only as the proxy's `/models` list, and the
provider is not a configured fact anywhere — PR #70 had to *derive* it by substring-matching the
model family (`modelProvider()`, `modules/proxy/models.ts`), recording an inferred provider into a
signed provenance document. CLIProxy is useful as a default, but it must not control which
providers and models the user can use. Research and settled decisions:
`docs/research_model_provider_selection.md` (D-ENV, D-FETCH, D-SHARE).

## What Changes

- A new user-owned **model connection** config block with two modes: `cliproxy` (today's
  behavior, the default — proxy endpoint, proxy client key, `/models` auto-resolve) and `direct`
  (user-supplied endpoint + provider, any Anthropic or OpenAI-compatible backend). The provider
  slug is a **configured fact in both modes** (in `cliproxy` mode setup records it from the
  authenticated account kind).
- A new env var `INFLEXA_MODEL_API_KEY` — the `direct`-mode secret, read through `lib/env.ts`,
  never persisted to config (D-ENV: config/state names the selection; env supplies the secret).
- Boot builds the chat provider from the **resolved connection** through the harness front door
  (`createConfiguredAiSdkProvider`; harness change `expose-provider-config`), replacing the
  hard-wired `createAnthropicProvider`-at-proxy-URL site. The `model_not_claude` guard generalizes
  to connection-aware resolution errors.
- `inflexa setup` gains the connection choice: provision CLIProxy (current flow) or configure a
  direct endpoint (write the config block; key via env).
- Provenance reads configured facts: the `{provider}/{model}` name is composed from the
  connection's provider slug + the resolved model id; the `modelProvider()` family-derivation
  table and its `unknown/` fallback are **removed**.
- Out of scope (follow-up change `select-seat-models`): per-seat model selection, palette
  commands, live switching.

## Capabilities

### New Capabilities

- `model-connection`: the user-owned chat-backend connection — config block (two modes), the
  env-var secret channel, boot resolution to a provider, and the setup-flow choice.

### Modified Capabilities

- `harness-runtime`: the three dep-realization requirements stop hard-coding "chat traffic
  targets the local proxy" — chat traffic targets the resolved model connection.
- `prov-harness-bridge`: the `emitProvenance` realization's model identity is composed from
  configured facts; the family-derivation and `unknown/` scenarios are replaced.
- `prov-run-events`: `ProvModelId`'s provider part is the connection's configured provider slug;
  the interim derivation clause is removed.

## Impact

- `cli/src/lib/config.ts` (config schema), `cli/src/lib/env.ts` (env var), `cli/src/modules/harness/config.ts`
  + `runtime.ts` + `run_deps.ts` (resolution + composition), `cli/src/modules/proxy/models.ts`
  (derivation removal), `cli/src/modules/infra/setup.ts` + `cli/src/cli/index.ts` (setup flow),
  provenance types/docs unchanged in mechanics (identity source only), tests throughout.
- Depends on harness change `expose-provider-config` (front-door factory) and builds on branch
  `record-model-agent` (PR #70) for the provenance surface.
- Backwards compatible: a config without the new block behaves exactly as today (cliproxy mode,
  provider `anthropic`, Claude-constrained auto-resolve).
