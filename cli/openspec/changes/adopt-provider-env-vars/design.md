## Context

`direct` mode today (`model-connection` spec) splits the connection into two halves with opposite
persistence rules: the non-secret `{ provider, baseURL, protocol }` lives in
`config.models.connection`, and the secret is read only from `INFLEXA_MODEL_API_KEY` via
`lib/env.ts` (the sole `process.env` reader), never written anywhere. `baseURL` is required to be
`/v1`-terminated — the wire layer POSTs `{baseURL}/messages` (anthropic) or
`{baseURL}/chat/completions` (openai-compatible) and GETs `{baseURL}/models`. The provider identity
is a configured fact, never derived from a model id.

The gap: a machine already provisioned for Claude Code / the SDKs carries `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, and matching `*_BASE_URL` gateways, and the CLI ignores all of them — the user
re-exports the key under a new name and re-types the endpoint.

## Goals / Non-Goals

**Goals:**
- Let `inflexa setup`'s direct path recognize the conventional provider env vars and pre-fill a
  connection the user confirms.
- Resolve the direct-mode key from the provider-conventional variable when `INFLEXA_MODEL_API_KEY`
  is unset — with zero new config surface and the existing never-persist guarantees intact.
- Normalize an adopted `baseURL` to the `/v1`-terminated form the wire layer needs.
- Enable a non-interactive `setup --connection direct` to self-configure from a detected env.

**Non-Goals:**
- A live boot-time env fallback (reading the env every run when config is empty). Rejected below.
- `ANTHROPIC_AUTH_TOKEN` (Anthropic-wire + Bearer) — needs a harness custom-auth capability.
- Bedrock/Vertex — no direct-mode HTTP `/v1` signer.
- Copying any secret value into config. Never.
- Per-provider special-casing beyond Anthropic + OpenAI-compatible (the `OPENAI_*` path already
  covers the Groq/Ollama/vLLM/LiteLLM long tail via `OPENAI_BASE_URL`).

## Decisions

**D1 — Detect & adopt at setup, not a live boot fallback.** Setup scans the env, offers a
pre-filled connection, and copies the result to config. Alternatives: (B) boot reads the env live
when `models.connection` is absent, like the SDKs; (C) both. Chosen A because a live read is a
surprise/precedence hazard — a user with `ANTHROPIC_API_KEY` exported for Claude Code but who wants
Inflexa on the managed `cliproxy` subscription would have it silently hijacked. A is explicit,
visible in config afterward, and — critically — its confirmation step is what makes baseURL
normalization safe (see D4).

**D2 — Provider-derived key fallback, no new config field.** `resolveModelApiKey(provider)` in
`lib/env.ts` tries `INFLEXA_MODEL_API_KEY` first, then the provider-conventional variable
(`ANTHROPIC_API_KEY` for `anthropic`, `OPENAI_API_KEY` otherwise). Alternatives: (K3) store an
explicit `apiKeyEnv` name in config — more flexible (arbitrary `MYCORP_TOKEN`) but adds config
surface and a drift point; (K1) keep the fixed var only — simplest, least convenient. Chosen K2
because the `provider` is already in config, so the fallback var is *derivable* — no new field, and
the secret is still read (never copied). `INFLEXA_MODEL_API_KEY` remains the explicit override so a
user can always force a specific key. The resolver takes `provider` as a parameter, so `lib/env.ts`
stays the sole `process.env` reader (the static eager `modelApiKey` field becomes this function).

**D3 — Copy the non-secret fields into config (snapshot), not a live reference.** At setup the
confirmed `{ provider, baseURL, protocol }` are written to `config.models.connection`. Alternative:
reference `ANTHROPIC_BASE_URL` live at boot. Chosen snapshot because config is already the one place
that describes the connection and drives the status surface, and a live read breaks a GUI/cron
launch that lacks the interactive shell's env. Staleness (gateway URL changes in env) is handled by
re-running setup, which re-detects and re-offers.

**D4 — Normalize the adopted `baseURL`, and confirm it.** The conventions are asymmetric:
`ANTHROPIC_BASE_URL` is a **bare root** (`https://api.anthropic.com`; the Anthropic SDK appends
`/v1/messages`), whereas Inflexa needs `/v1`-terminated. `OPENAI_BASE_URL` is usually already
`/v1`-terminated. So adoption appends `/v1` when the path lacks a version segment, and defaults to
the provider's public root (`https://api.anthropic.com/v1`, `https://api.openai.com/v1`) when no
`*_BASE_URL` is set. Because gateway roots are genuinely ambiguous (`https://gw.corp/anthropic` →
`/v1`?), the normalized URL is **shown as an editable pre-fill** the user confirms — the ambiguity
becomes a one-keystroke edit rather than a silent 404. D1's offer-flow is what affords this.

**D5 — Auth-header scheme fixes the v1 env scope.** The harness anthropic provider passes the key as
`apiKey` → the AI SDK sends `x-api-key`; the openai-compatible path sends `Authorization: Bearer`.
So `ANTHROPIC_API_KEY` (x-api-key) and `OPENAI_API_KEY` (bearer) are natively supported;
`ANTHROPIC_AUTH_TOKEN` (Anthropic-wire + Bearer) is **not** without a harness change, so it is
deferred. A gateway that wants a bearer token can still be adopted today as
`protocol: openai-compatible`, which sidesteps the gap; only an Anthropic-*wire*-and-Bearer gateway
is unreachable in v1.

**D6 — Both-ecosystem tiebreak.** When both `ANTHROPIC_*` and `OPENAI_*` are present, interactive
setup prompts which to adopt; a non-TTY setup applies a deterministic precedence (anthropic before
openai) so scripted runs are reproducible.

## Risks / Trade-offs

- **Config `baseURL` goes stale when the gateway URL rotates in env** → re-running `inflexa setup`
  re-detects and re-offers; a passive drift warning is a possible follow-up, deferred.
- **Normalization guesses wrong for an unusual gateway root** → mitigated by D4's confirm-the-prefill
  step; a wrong guess is visibly editable before write.
- **An Anthropic-wire + Bearer gateway (`ANTHROPIC_AUTH_TOKEN` only) is unreachable in v1** →
  documented; workaround is `protocol: openai-compatible` or an explicit `INFLEXA_MODEL_API_KEY`.
- **Non-TTY auto-adopt could surprise in CI if provider vars are unexpectedly present** → gated to
  when the user *explicitly* chose `--connection direct`; it never fires on the default cliproxy path.

## Migration Plan

Purely additive, no config migration. An absent `models` block still resolves to cliproxy
(unchanged). Existing `INFLEXA_MODEL_API_KEY` users are unaffected — it stays precedence #1. The
only behavioral change for an existing direct-mode user is that an unset `INFLEXA_MODEL_API_KEY`
now falls back to a provider var instead of failing immediately; the failure path still fires when
neither resolves, with an error that now names both variables. Rollback is removing the resolver
fallback + the setup detection branch; config written by the feature (`{provider, baseURL,
protocol}`) is valid under the pre-change schema.

## Open Questions

- Should re-running setup actively flag drift between config `baseURL` and the current
  `ANTHROPIC_BASE_URL`, or silently re-offer? (Leaning: silent re-offer for v1.)
- Is anthropic-before-openai the right non-TTY precedence, or should it key off which `*_BASE_URL`
  is present? (Leaning: anthropic-first, simplest and documented.)
