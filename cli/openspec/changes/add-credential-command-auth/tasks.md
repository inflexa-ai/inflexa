## 1. Config surface (auth block)

- [x] 1.1 Extend the `models.connection` schema (`src/modules/harness/config.ts`) with an optional `auth` block: `{ kind: "env"; var; scheme }` | `{ kind: "command"; command; scheme; format?: "raw" | "exec-credential"; ttlMs? }`, `scheme: "x-api-key" | "bearer"`. Carry it on `ResolvedModelConnection` (direct arm). — schema (`modelAuthSchema`/`ModelAuthConfig`) added in `src/lib/config.ts` beside `modelConnectionSchema` (where that schema lives); `ResolvedModelConnection.auth` carried in `src/modules/harness/config.ts`.
- [x] 1.2 Validate it in `resolveModelConnection` (fail-closed with a config error naming the offending field, same pattern as the rest of the block).

## 2. Credential source resolver (env.ts)

- [x] 2.1 In `src/lib/env.ts`, add a `CredentialSource` = cached async supplier returning `{ token, scheme, expiresAt? }`; keep `lib/env.ts` the sole `process.env` reader for the env kinds.
- [x] 2.2 `kind: "env"` — read the named var; no expiry; scheme as configured.
- [x] 2.3 `kind: "command"` — run the command via `Bun.spawn`, boundary-wrapped to `Result`; parse stdout as raw token (default) OR Kubernetes `ExecCredential` JSON (`status.token` + `status.expirationTimestamp`).
- [x] 2.4 Caching + refresh: reuse until `expiresAt − buffer`; fall back to `ttlMs` for a raw token; expose a `forceRefresh()` for the 401 path.
- [x] 2.5 Resolution precedence: a configured `auth` source wins; otherwise fall back to the existing `resolveModelApiKey(provider)` (as an env `x-api-key`/`bearer` source). — precedence encoded in boot's direct branch (`runtime.ts`) against the injectable `readModelApiKey` seam; the env key is wrapped by `staticCredentialSource`.

## 3. Wire injection (provider construction)

- [x] 3.1 At the provider-construction site (`src/modules/harness/runtime.ts`), build the `fetch` passed as harness `config.fetch`: per request, get the token from the source and set the auth header — `bearer` deletes any `x-api-key` and sets `Authorization: Bearer`; `x-api-key` sets `x-api-key`. Pass a placeholder `apiKey` so the SDK doesn't fight it.
- [x] 3.2 On an HTTP `401`, `forceRefresh()` and retry the request exactly once.

## 4. Setup detection, offer, and validation

- [x] 4.1 Extend detection (`src/modules/infra/setup.ts`, alongside `detectProviderEnv`) to recognize a helper setup: `claude auth status` api-key-helper method, an `apiKeyHelper` in `~/.claude/settings.json` / managed-settings, or `ANTHROPIC_AUTH_TOKEN` in env. — detects the reliable subset: user/managed `apiKeyHelper` (settings.json) + `ANTHROPIC_AUTH_TOKEN`; the `claude auth status` api-key-helper method writes an `apiKeyHelper` into settings.json, so the settings signal subsumes it (no fragile subprocess).
- [x] 4.2 When detected, offer the credential-source path (credential command / env bearer) in the direct-connection flow; the user supplies/confirms the command (MAY pre-fill from the user's OWN settings; NEVER auto-execute the org managed-settings helper).
- [x] 4.3 Add a setup validation probe: run the resolved source once and hit `GET {baseURL}/models` (or a minimal call); on failure, report an actionable cause (command / scheme / endpoint) and do NOT write the `auth` block.
- [x] 4.4 Write only `{ kind, var|command, scheme, format?, ttlMs? }` into `models.connection.auth` — never a token.

## 5. Documentation

- [x] 5.1 Document the `auth` block + the two output formats (raw / ExecCredential) and the scheme in the CLI help / setup notes; state that the token value is never persisted. — documented on `modelAuthSchema` JSDoc, the setup "Model credential source" / "Model API key" notes, and env.ts credential-source docs.

## 6. Tests

- [x] 6.1 CredentialSource: env-bearer source; command raw token cached + refreshed after TTL; ExecCredential parse + expiry-driven refresh; `forceRefresh` re-runs; a configured source overrides `INFLEXA_MODEL_API_KEY`. — CredentialSource unit tests in `env.test.ts` (env/command/exec-credential, cache, forceRefresh); the override is a boot test in `runtime.test.ts` (auth block ⇒ `readModelApiKey` never consulted).
- [x] 6.2 Wire injection: `bearer` sets `Authorization: Bearer` and strips `x-api-key`; `x-api-key` sets `x-api-key`; a 401 triggers exactly one refresh+retry (assert the outgoing headers/behavior).
- [x] 6.3 Config: a valid `auth` block round-trips; an invalid one fails closed with a named config error.
- [x] 6.4 Setup: detection offers the path; a confirmed command writes `{command, scheme}` and no token; the probe blocks a bad config; the managed-settings helper is not auto-executed.
- [x] 6.5 `bun run typecheck`, `bun run lint`, `bun test` pass; run `bun run format:file` on every changed `src/` file. — typecheck/lint green; all new tests pass; one pre-existing WSL2 proxy/loopback embedding test fails identically on the clean base (unrelated).
