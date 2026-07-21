## Why

Enterprise gateways that front Anthropic models (Bedrock/Vertex behind a corporate proxy, IdP-minted
bearer JWTs) routinely serve **only** `POST {baseURL}/messages` — no `/models`, no
`count_tokens`, non-standard error statuses (500 for a bad token, not 401). Against exactly this
shape — verified live with a gateway probe on an enterprise user's machine — today's setup discards a
freshly-validated credential source because its probe hard-requires `GET {baseURL}/models` to answer
2xx, then falls back to a static `x-api-key` the gateway rejects; direct setup never collects a model
id so boot fails `model_required`; and the picker/validation surfaces hardcode `x-api-key`, which can
never succeed on a bearer-only gateway. A helper-minted raw JWT is also aged by a blanket 5-minute
TTL instead of its own `exp` claim, so a cached, nearly-expired helper token can be held past its
real lifetime — and the 401-only reactive refresh never fires on a gateway that signals rejection
with 500.

## What Changes

- **Credential-source probe ladder**: `probeCredentialSource` treats `/models` as opportunistic —
  2xx validates (and feeds the model pre-fill list); 401/403 anywhere fails with the scheme hint;
  any other outcome escalates to the protocol-shaped authoritative probe: a `max_tokens: 1` POST to
  `{baseURL}/messages` (anthropic) or `{baseURL}/chat/completions` (openai-compatible). A definite
  model-not-found on the ping still passes the *credential* probe. An ambiguous outcome (non-2xx,
  non-auth — e.g. a gateway that 500s) shows the status/body excerpt and offers save-anyway instead
  of silently discarding the auth block.
- **Direct setup collects the model id**: after the connection (and optional auth block) is
  settled, setup prompts for the model with a three-tier pre-fill — ranked `/models` listing when it
  answered, a provider-conventional default from a small declared table (anthropic/openai/google;
  free-text editable, never silently written) when it didn't, plain free text otherwise — validates
  the confirmed id via the same ping, and persists it to both agents. This amends the flow-level "no
  hardcoded model ids" requirement with a narrow, declared exception: pre-fill-only conventional
  defaults, ping-validated before persisting.
- **Raw JWT tokens age off their own `exp` claim**: a `command`-minted raw token that parses as a
  JWT gets `expiresAt = min(exp, now + ttlMs)`; the 5-minute default applies only when no `exp` is
  readable. Unparseable payloads degrade to today's behavior, never error.
- **Picker surfaces honor the credential source**: model listing and commit-time validation
  (`model_listing.ts`) authenticate through the configured `CredentialSource` and scheme (bearer or
  x-api-key) when an `auth` block exists, instead of unconditionally reading the static env key and
  sending `x-api-key`.

## Capabilities

### New Capabilities

(none — every change amends requirements of existing capabilities)

### Modified Capabilities

- `model-connection`: the credential-source requirement gains JWT-`exp`-driven expiry for raw
  command tokens; the setup credential-probe requirement is rewritten from "GET /models must
  succeed" to the probe ladder with save-anyway on ambiguity; the setup connection-flow requirement
  gains the direct-mode model prompt with the tiered pre-fill, amending "no hardcoded model ids" to
  permit the declared conventional-default table (pre-fill only, validated before persisting).
- `agent-model-selection`: the listing-picker requirement's anthropic listing and accessibility
  validation authenticate via the configured credential source and scheme when an `auth` block is
  present, rather than the static env key as `x-api-key`.

## Impact

- `cli/src/lib/credential.ts` — JWT payload decode in `parseCommandCredential` (raw branch).
- `cli/src/modules/infra/setup.ts` — `probeCredentialSource` ladder, save-anyway flow in
  `offerCredentialSource`, direct-flow model prompt + persistence (`writeAgentModel`).
- `cli/src/modules/proxy/models.ts` — `MODEL_FAMILIES` gains the conventional-default column
  (provider→default, the allowed derivation direction; the id→provider ban is untouched).
- `cli/src/modules/harness/model_listing.ts` — credential-source-aware auth for `requestFor` and
  `validateModelSelection`.
- No harness changes; no new dependencies; config schema unchanged (`auth` block shape is already
  sufficient). Existing cliproxy flows untouched.
