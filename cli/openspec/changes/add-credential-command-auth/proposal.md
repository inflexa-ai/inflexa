## Why

Enterprises that buy Anthropic API tokens increasingly issue them through a **credential helper** — a
script that mints a **short-lived** first-party token on demand (the pattern Claude Code's
`apiKeyHelper`, AWS `credential_process`, and kubectl exec-plugins all use) — rather than a static
key. Inflexa's `direct` mode today resolves the key **once at boot** as a static string and only
sends it as `x-api-key`. That can't consume a rotating helper token (it goes stale) and can't send an
`Authorization: Bearer` token (what WIF / gateway credentials require). This change lets `direct`
mode use those already-sanctioned credential sources, so an employee on a company-token plan can run
Inflexa against their existing budget with a one-time opt-in.

## What Changes

- **A refreshing credential source for `direct` mode.** New `models.connection.auth` block naming
  either an env var (`{ kind: "env", var, scheme }` — e.g. a short-lived `ANTHROPIC_AUTH_TOKEN`
  bearer) or a command (`{ kind: "command", command, scheme, format?, ttlMs? }`). Only the **name**
  is stored — the token value is never written to config, telemetry, logs, or provenance.
- **Standard, testable formats — nothing bespoke.** A command's stdout is either a **raw token**
  (byte-for-byte Claude Code `apiKeyHelper` parity) or **Kubernetes `ExecCredential` JSON**
  (`client.authentication.k8s.io/v1`, `status.token` + `status.expirationTimestamp`). Refresh mirrors
  AWS `credential_process`: honor the expiry, fall back to `ttlMs` for a raw token, force-refresh on a
  `401`.
- **Bearer wire scheme.** The token reaches the wire as `x-api-key` or `Authorization: Bearer` per
  `scheme`, injected through the harness `config.fetch` seam — so **no hard harness change** (the seam
  already exists). This also closes the `ANTHROPIC_AUTH_TOKEN` gap deferred in `adopt-provider-env-vars`.
- **Setup detection + opt-in.** Setup detects a helper-based Anthropic setup (from
  `claude auth status` authMethod, an `apiKeyHelper` in Claude settings, or `ANTHROPIC_AUTH_TOKEN` in
  env) and OFFERS the credential-source path. The user **confirms/supplies the command** — setup does
  not silently lift and execute the org's managed-settings helper.
- **Setup validation.** Before writing config, setup runs the source once and does a cheap auth probe
  against the endpoint, so a bad command / scheme / endpoint fails at setup, not first chat.

## Capabilities

### New Capabilities
<!-- None — extends model-connection, which already owns the direct-mode credential channel and the setup connection flow. -->

### Modified Capabilities
- `model-connection`: the direct-mode credential may now be a **refreshing source** (an env bearer
  token or a credential command emitting a raw token / ExecCredential JSON) in addition to the static
  env key; the token is sent as `x-api-key` or `Bearer` per a configured scheme; and setup detects a
  helper-based setup and offers the credential-command path with a validation probe.

## Impact

- **Code:** `cli/src/lib/env.ts` (a `CredentialSource` resolver — cache + refresh over env/command,
  raw/ExecCredential parsing, `Bun.spawn` boundary-wrapped as `Result`); the provider-construction
  site in `cli/src/modules/harness/` (build the auth-injecting `fetch` passed as `config.fetch`, with
  scheme rewrite + 401-retry); `cli/src/modules/infra/setup.ts` (helper detection, the opt-in
  credential-source prompt, and the validation probe).
- **Spec:** `model-connection` delta (1 modified + 2 added requirements).
- **No new dependencies. No hard harness change** (bearer handled in the injected fetch); an optional
  first-class `{ getToken, authScheme }` on the harness provider config is noted as a future cleanup.
- **Security posture preserved:** no token value is ever persisted; config holds only the source
  name/command and scheme.
- **Sequenced after `adopt-provider-env-vars`** (builds on its `direct`-mode key resolution).
