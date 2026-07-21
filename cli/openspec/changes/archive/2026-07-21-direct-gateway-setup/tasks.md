## 1. JWT expiry for raw command tokens (lib/credential.ts)

- [x] 1.1 Add a JWT `exp` extraction helper to the raw branch of `parseCommandCredential`: base64url-decode the payload of an `eyJ*` token, read a numeric `exp` (seconds); any failure yields "no self-described expiry" — never an error
- [x] 1.2 Compute `expiresAt` as the earliest of `exp × 1000` and `now + ttlMs` (when set); apply `DEFAULT_RAW_TOKEN_TTL_MS` only when no `exp` was readable; a past `exp` still yields the (expired-marked) credential
- [x] 1.3 Unit tests: JWT with near `exp` beats the default TTL; `ttlMs` earlier than `exp` wins; `exp` earlier than `ttlMs` wins; undecodable payload falls back to default TTL; past `exp` returns a credential that immediately refreshes; non-JWT raw tokens unchanged

## 2. Conventional-default model table (modules/proxy/models.ts)

- [x] 2.1 Add an optional conventional-default column to `MODEL_FAMILIES` (anthropic/openai/google entries only), with the rot-risk comment and the pre-fill-only contract stated; export a `conventionalDefaultModel(provider)` lookup
- [x] 2.2 Unit test: known slugs resolve their default, unknown slugs resolve none; assert the direction ban (no id→provider path) is untouched

## 3. Probe ladder + save-anyway (modules/infra/setup.ts)

- [x] 3.1 Rework `probeCredentialSource` into the ladder: `/models` 2xx passes (returning any listed ids for the pre-fill), 401/403 anywhere fails with the scheme hint, other `/models` outcomes escalate to the protocol-shaped `max_tokens: 1` POST (`/messages` + `anthropic-version` for anthropic, `/chat/completions` for openai-compatible); the ping accepts 2xx or a definite model-not-found body; anything else returns a distinct `ambiguous` outcome carrying status + body excerpt
- [x] 3.2 Probe with the user's confirmed model id when available; fall back to the provider-conventional default id (model-not-found still passes) when the model is not yet known
- [x] 3.3 In `offerCredentialSource`, name the 1-token spend in the spinner text; on `ambiguous`, show the status/body excerpt and offer save-anyway (accept writes the auth block unchanged, decline discards)
- [x] 3.4 Unit tests against injected fetch: 404-`/models`-then-200-ping passes; 401 on either rung fails with the scheme message; 500 ping yields `ambiguous` with the excerpt; model-not-found ping body passes the credential probe

## 4. Direct-mode model prompt (modules/infra/setup.ts)

- [x] 4.1 After the connection (and optional auth block) is settled, prompt for the model id with the three-tier pre-fill: ranked `/models` ids from the probe when 2xx → `conventionalDefaultModel(provider)` → empty free text
- [x] 4.2 Validate the confirmed id with the shared ping shape: definite model-not-found re-prompts showing the endpoint's error body; ambiguous offers save-anyway; a pass persists via `writeAgentModel` to BOTH agents
- [x] 4.3 Keep the non-TTY direct path model-less (no prompt, nothing written) and leave boot's `model_required` as the documented failure
- [x] 4.4 Unit tests for the pre-fill precedence and the commit outcomes (pass persists both agents; not-found re-prompts; ambiguous save-anyway persists on accept)

## 5. Credential-source-aware picker surfaces (modules/harness/model_listing.ts)

- [x] 5.1 Extend the listing/validation seams with a credential resolution that prefers the connection's `auth` block (via `createCredentialSource`, sent per its scheme) and falls back to the static env key with today's per-protocol headers
- [x] 5.2 Apply it in `requestFor` (listing GET) and `validateModelSelection` (count_tokens POST); a source resolution failure maps to the existing `key_missing` / `inconclusive` degradations
- [x] 5.3 Unit tests: bearer auth block produces `Authorization: Bearer` and no `x-api-key` on both surfaces; absent auth block preserves today's headers; source failure degrades (free-text / inconclusive-accept), never throws

## 6. Verification

- [x] 6.1 `bun run typecheck`, `bun run lint`, `bun test` green; `bun run format:file` on every touched src file
- [x] 6.2 Manual sweep with a stub gateway (messages-only, bearer-only, 500-on-bad-token): interactive direct setup end-to-end writes connection + auth + model with no hand-editing; picker degrades to free text; chat boots
- [x] 6.3 `openspec validate direct-gateway-setup --strict` passes; re-read the deltas against the implementation for drift
