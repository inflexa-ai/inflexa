## Why

Users installing the Inflexa CLI in a `direct` connection almost always already have their LLM
access configured in the ecosystem's conventional environment variables — `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, and the matching `*_BASE_URL` gateways their company issues. Today the CLI reads
none of them: the key must be re-exported as `INFLEXA_MODEL_API_KEY` and the endpoint re-typed at
`inflexa setup`, which is friction that makes the CLI feel unaware of a machine that is already set
up for Claude Code / the SDKs.

## What Changes

- **Setup detects the high-value provider env vars** (`ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`,
  `OPENAI_API_KEY`/`OPENAI_BASE_URL`) and offers a pre-filled `direct` connection the user confirms
  — an *onboarding* convenience, never a silent runtime binding.
- **The non-secret connection fields (`provider`, `baseURL`, `protocol`) are copied into
  `config.models.connection`** at setup (a snapshot the status surface already renders). The API key
  is **never** copied.
- **The direct-mode key gains a provider-derived fallback.** `INFLEXA_MODEL_API_KEY` still wins;
  when unset, the CLI reads the provider-conventional variable (`ANTHROPIC_API_KEY` for
  `anthropic`, `OPENAI_API_KEY` otherwise) — still env-only, still never persisted, still resolved
  through `lib/env.ts` (the sole `process.env` reader), now via a provider-parameterized resolver.
- **Adopted `baseURL` is normalized** to the `/v1`-terminated form the wire layer requires, because
  the `ANTHROPIC_BASE_URL` convention is a bare root (`https://api.anthropic.com`) while Inflexa
  POSTs `{baseURL}/messages`. The normalized value is shown for confirmation, so ambiguous gateway
  roots are a one-keystroke edit, not a silent 404.
- **Non-TTY `setup --connection direct` can self-configure** from a detected env with no prompts —
  a scriptable/CI setup path.
- **Out of scope (documented, not implemented):** `ANTHROPIC_AUTH_TOKEN` (Anthropic-wire + Bearer)
  needs a harness custom-auth-header capability the CLI cannot supply alone; Bedrock/Vertex have no
  direct-mode signer. Both are noted as deferred.

## Capabilities

### New Capabilities
<!-- None — this extends the existing model-connection capability, whose stated purpose already owns the environment-only secret channel and the setup-flow connection choice. -->

### Modified Capabilities
- `model-connection`: the direct-mode key resolution gains a provider-derived environment fallback
  after `INFLEXA_MODEL_API_KEY`; setup's direct path gains ecosystem-env detection with a confirmed,
  `/v1`-normalized pre-fill copied into config; boot's endpoint resolution stays config-only (the
  detection is a one-time setup read, not a runtime binding).

## Impact

- **Code:** `cli/src/lib/env.ts` (`modelApiKey` static field → a `resolveModelApiKey(provider)`
  resolver + extended `envDoc`), `cli/src/modules/infra/setup.ts` (`promptDirectConnection` gains
  detection/prefill + baseURL normalization; non-TTY direct path), `cli/src/modules/harness/config.ts`
  / the provider-construction site (consume the provider-derived key).
- **Spec:** `model-connection` delta (two modified/added requirements).
- **No new dependencies. No harness change** in scope (the one harness-dependent case,
  `ANTHROPIC_AUTH_TOKEN` bearer auth, is deferred).
- **Security posture preserved exactly:** no API key value is ever written to `config.json`,
  telemetry, logs, or provenance.
