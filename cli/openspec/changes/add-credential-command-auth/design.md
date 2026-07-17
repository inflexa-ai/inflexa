## Context

`direct` mode (post `adopt-provider-env-vars`) resolves the API key **once at boot** via
`resolveModelApiKey(provider)` → a static string passed as the AI SDK `apiKey`, sent as `x-api-key`
(anthropic wire) or `Authorization: Bearer` (openai-compatible). The harness provider construction
(`harness/src/providers/ai-sdk.ts`) already threads a custom `fetch` into both
`createAnthropic({ baseURL, apiKey, fetch })` and `createOpenAICompatible({ ..., fetch })`.

Enterprises increasingly issue Anthropic access through a **credential helper** that mints a
short-lived first-party token on demand. A static-string-at-boot model can neither refresh such a
token nor send it as a Bearer on the anthropic wire. Research confirmed CLIProxyAPI is not a
substitute (it holds a static upstream key and cannot run an external helper), so the refresh must
live in Inflexa.

## Goals / Non-Goals

**Goals:**
- Let `direct` mode consume a refreshing credential source: an env bearer token or a command.
- Conform to existing, proven contracts so interop is guaranteed, not guessed.
- Detect a helper-based setup and offer it at setup, opt-in, with a validation probe.
- Close the `ANTHROPIC_AUTH_TOKEN` (Bearer) gap deferred in `adopt-provider-env-vars`.

**Non-Goals:**
- Reimplementing OAuth / WIF token exchange — the *command* mints the token; we consume it.
- Auto-executing the org's `managed-settings.json` helper without user confirmation.
- Using CLIProxyAPI for this case (established: it adds nothing for a first-party token).
- Mid-stream token refresh (unnecessary — see D4).

## Decisions

**D1 — A credential SOURCE, not a string.** Replace "resolve a string" with a cached async supplier
`CredentialSource = () => Promise<{ token, scheme, expiresAt? }>`. The static env key stays one
(expiry-less) source; env-bearer and command are the new ones. Caching keyed by expiry means the
command runs only on refresh, not per request.

**D2 — Two proven output formats, nothing bespoke.** A command's stdout is either (a) a **raw token**
— byte-for-byte Claude Code's `apiKeyHelper`, so an org's existing helper works unchanged (the
strongest "it works" guarantee), or (b) **Kubernetes `ExecCredential` JSON**
(`client.authentication.k8s.io/v1`, `status.token` + `status.expirationTimestamp`) — a versioned,
widely-implemented standard for short-lived bearer tokens with expiry. Rejected: adopting the AWS
`credential_process` shape as a parse target — its token field is `SessionToken`/`AccessKeyId`,
awkward for a plain bearer; we mirror its *refresh contract* (Version-gate + Expiration) without its
field names.

**D3 — Inject via the `config.fetch` seam (CLI-side), no hard harness change.** The CLI builds the
`fetch` passed as `config.fetch`. Per request it calls the source and sets the auth header: for
`bearer` it deletes the `x-api-key` the AI SDK added and sets `Authorization: Bearer`; for
`x-api-key` it sets `x-api-key`. The static `apiKey` becomes a placeholder. Alternative: add a
first-class `{ getToken, authScheme }` to `AiSdkProviderConfig` (cleaner, but a harness change). Chose
the fetch seam for v1 because it already exists and keeps the whole credential concern in the
embedder; the first-class API is noted as a future cleanup. This one seam also delivers Bearer for
`ANTHROPIC_AUTH_TOKEN`, closing the prior deferral.

**D4 — Refresh = expiry + ttl fallback + 401 retry; no mid-stream refresh.** A single request uses the
header set at its start and Anthropic validates auth at request start, so a token cannot expire
mid-request. Per-request resolution in the fetch wrapper (returning the cached token, refreshing when
`now >= expiresAt - buffer`), plus one forced-refresh retry on a `401`, covers every case. Raw tokens
with no expiry use `ttlMs` (Claude Code's `apiKeyHelper` default is 5 min + refresh-on-401).

**D5 — Detect, then let the user confirm the command (never auto-wire).** Setup detects a helper
setup from read-only signals (`claude auth status` authMethod=api_key_helper; an `apiKeyHelper` in
`~/.claude/settings.json` / managed-settings; `ANTHROPIC_AUTH_TOKEN` in env) and OFFERS the
credential-source path. The user supplies/confirms the command (may be pre-filled from their own
user-level settings). We do NOT silently lift and execute the org's `managed-settings.json` helper —
that keeps the governance decision with the user/org and is more robust (the managed file may be
unreadable or need special env).

**D6 — Validate at setup.** Before writing config, run the source once and do a cheap auth probe
(`GET {baseURL}/models`, or a minimal call) so a wrong command / scheme / endpoint fails at setup, not
on first chat. A rotating-token flow is easy to misconfigure; the probe is the "sure it works" gate.

## Risks / Trade-offs

- **Running a configured command is code execution** → same trust model as AWS `credential_process` /
  Claude Code `apiKeyHelper` (user/admin configures it); only the command *name* is stored, never
  output. The `Bun.spawn` call is boundary-wrapped to `Result`.
- **Bearer rewrite depends on stripping the AI SDK's `x-api-key`** → mitigated by passing a placeholder
  `apiKey` and setting the header explicitly in our fetch; covered by a test asserting the outgoing
  header.
- **Command latency** → caching means it runs only on refresh; a slow helper delays only a refresh, not
  every request.
- **ExecCredential/raw parse variance across helpers** → the setup probe (D6) surfaces it immediately;
  parsing is boundary-wrapped and errors are actionable.

## Migration Plan

Purely additive. Configs without an `auth` block behave exactly as today (static env key). No config
migration. Rollback removes the `auth` resolution + setup branch; the static path is untouched.
Sequenced on top of `adopt-provider-env-vars`.

## Open Questions

- Pre-fill the detected command from the user's OWN `~/.claude/settings.json` `apiKeyHelper` (but not
  the org managed file)? (Leaning: yes for user-level, shown editable.)
- Infer `scheme` from the token prefix (`sk-ant-api…`→x-api-key, `sk-ant-oat…`→bearer) as a default,
  or always ask? (Leaning: infer a default, let the user override — the setup probe validates it.)
