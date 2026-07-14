## Context

inf-cli (Bun + TypeScript, cac command registry, neverthrow `Result` error style) needs Auth0 authentication so it can call the Nexus server's protected API. A sibling admin CLI is the protocol reference: it hand-rolls the device flow against `POST /oauth/device/code` + polled `POST /oauth/token`. That admin tool deliberately omits refresh tokens (it is high-privilege); inf-cli is user-facing and explicitly requires the opposite — login once, ~30-day sliding session, silent renewal on use.

Repo constraints that shape this design: no new dependencies; `src/lib/env.ts` is the only `process.env` reader (ESLint-enforced); named exports only; domain types instead of raw strings; lib-layer errors as neverthrow `Result`s.

## Goals / Non-Goals

**Goals:**

- `inf login` / `inf logout` / `inf whoami` as top-level commands.
- Device Authorization Flow with `openid profile email offline_access` scope + API audience; rotating refresh token persisted across renewals.
- A single reusable entry point — `getValidAccessToken()` — that future API callers (chat backend) use without knowing about refresh mechanics.
- Zero new dependencies.

**Non-Goals:**

- Calling any Nexus server endpoint (whoami is local-only; the chat backend integration is a later change).
- OS keychain storage (file with `0600` perms, matching the sibling admin CLI).
- Auth0 tenant provisioning (rotation, lifetimes, grant types are dashboard config owned by the user).
- ID/access token signature verification — tokens arrive directly from Auth0 over TLS; signature checks are the API server's job.

## Decisions

**1. Hand-rolled `fetch`, no SDK.** Auth0 ships no Node SDK for device flow (the official `auth0` npm package has no device-flow initiation method; verified against its source). `openid-client` would add 3 packages / ~800 KB to save a ~20-line poll loop. Hand-rolling matches both the repo's no-deps rule and the sibling admin CLI's precedent. Alternatives considered: `openid-client@6` (best library, rejected on dependency weight), `oauth4webapi` (zero-dep but still requires writing the poll loop — worst of both).

**2. Poll-loop errors keyed off the JSON body's `error` field, not HTTP status.** Auth0 deviates from RFC 8628's uniform 400 (it returns 403 for `authorization_pending`, 429 for `slow_down`). Handling: `authorization_pending` → continue; `slow_down` → interval += 5s (RFC 8628 §3.5); `expired_token` → fail "code expired, run login again"; `access_denied` → fail "denied". Hard deadline from `expires_in`.

**3. Token file: `{configDir}/inf/auth.json`, `0600`.** Sits next to `config.json`; path defined in `env.ts` and listed in `envDoc` so `--help` shows it. Shape: `{ accessToken, refreshToken, idToken, expiresAt }` (ISO-8601 expiry, computed from `expires_in` at save time). Separate file from `config.json` because credentials and settings have different lifecycles and the token file is rewritten on every refresh.

**4. Refresh: `getValidAccessToken()` is the only public read path for the access token.** It loads the file; if the token has >60s of life it returns it; otherwise it runs `grant_type=refresh_token` and persists the response **before** returning. With rotation enabled, every refresh response carries a new refresh token and the old one is invalidated — persisting via write-temp-then-rename keeps the update atomic so a crash mid-refresh cannot strand a dead token on disk. A refresh failure returns a typed error telling the user to run `inf login`. The 30-day sliding window itself lives in Auth0 tenant config (inactivity lifetime resets on each use), not in CLI code.

**5. `whoami` decodes the ID token locally — no network.** Base64url-decode the JWT payload, print `sub` / `email` / `name`, plus session state derived from `expiresAt` and refresh-token presence. Auth0's `/userinfo` is per-user rate-limited, which is wrong for a reflexively-run command. No signature check (see Non-Goals).

**6. `logout` revokes, then deletes.** `POST /oauth/revoke` with `client_id` + the refresh token (no secret needed for native apps) invalidates the whole grant family server-side; failures (offline, already revoked) are reported but never block deleting `auth.json` — local logout must always succeed.

**7. Auth0 config is baked into release binaries at compile time; runtime-read only in dev.** `env.ts` exposes the three values through a dedicated frozen `bakedEnv` object (separate from the user-facing `env`), read via literal `process.env.INF_AUTH0_*` dot access — load-bearing, because Bun's bundler only inlines static member expressions, never dynamic `process.env[name]` index reads. The release build (`bun run build` → `scripts/build.ts`) derives the baked-var set by scanning the `bakedEnv` block in `env.ts` for literal `process.env.<NAME>` accesses — the object holds values, not names, so source scanning is the only way to keep `env.ts` the single source of truth; adding a dot access there is the entire procedure for baking a new value. The build fails fast when any derived var is unset, then passes one `define` entry per var to `Bun.build({ compile })`; per-var defines (rather than an `--env` prefix glob) ensure runtime vars like `INF_LOG_LEVEL` can never be swept into the binary. The compiled executable disables `bunfig.toml`/`.env` autoloading so cwd contents cannot alter behavior. In dev the same expressions are plain runtime reads, so a local `.env` works unchanged, and `login` still validates and names missing values. The vars are not listed in `envDoc`/`--help`: end users of a compiled binary cannot change them, so documenting them would mislead. Baked values are extractable from the binary by design — this is immutability, not secrecy; public client, no secret exists. Build-script detail: `scripts/build.ts` must use the JS API (the Solid JSX transform is a bundler plugin, unavailable to the `bun build` CLI) and must reset the opentui transform plugin's global state, which the repo bunfig preload otherwise leaks into the build, producing unresolvable `opentui:runtime-module:` virtual imports. `bun run build` compiles the host target only; `bun run build:all` cross-compiles the four-target release matrix (darwin-arm64, darwin-x64, linux-x64, windows-x64) — this requires installing every `@opentui/core-<os>-<arch>` native package first (`bun install --os="*" --cpu="*"`) and baking `OPENTUI_LIBC=glibc` into linux targets. The build ends with a smoke test (host binary `--version`) so a binary that compiles but cannot start fails the build, not the user; cross-compiled targets cannot be executed on the build host and are verified by format only. This architecture matches opencode's production OpenTUI build (`packages/opencode/script/build.ts` in the anomalyco repo): same JS-API script, same plugin, same autoload disabling, same `define`-based baking.

**8. Errors as a typed union in `src/lib/auth.ts`** (`AuthError` discriminated on `type`: e.g. `not_authenticated`, `device_code_request_failed`, `authorization_expired`, `authorization_denied`, `refresh_failed`, `token_write_failed`), returned via neverthrow `Result`/`ResultAsync`, matching `config.ts` and the db layer. Commands `.match()` and print friendly messages, exiting non-zero on failure like `sessions.ts`.

**9. Zod for every JSON trust boundary (explicitly approved dependency).** Auth0 responses, the on-disk `auth.json`, decoded ID-token claims, and `config.json` are all external input; the original hand-rolled `typeof` ladders and a generic `JSON.parse` cast were correctness risks (a blind cast trusts the wire shape it claims to validate). Each boundary now has a zod schema, with TypeScript types derived via `z.infer` so schema and type cannot drift, and a shared `parseWith(schema, raw)` helper in `auth.ts` that returns `null` on parse-or-validation failure for callers to wrap in their typed errors. Zod's default unknown-key stripping also future-proofs claim/config parsing. Alternatives considered: keep hand-rolled guards (scales badly, already produced a blind-cast helper), valibot (smaller but zod is the de-facto standard the team knows).

**10. Browser opening is best-effort, never load-bearing.** `Bun.spawn` of `open` (darwin) / `xdg-open` (linux) / `cmd /c start` (win32) on the `verification_uri_complete`; the URL and code are always printed, and spawn failures are silently ignored — SSH sessions and headless terminals just use the printed URL.

## Risks / Trade-offs

- [Stale rotated refresh token: two concurrent inf processes refresh simultaneously; the loser's token is revoked by reuse detection, killing the family] → Accepted for now: refresh happens at most once per access-token lifetime (hours), making the race window tiny; recovery is just `inf login`. Documented as a `TODO(robustness)` candidate (file locking) rather than built speculatively.
- [Plaintext token on disk] → `0600` perms, same posture as the sibling admin CLI, gh, and most CLIs; keychain integration would need a dependency or platform-specific shelling.
- [Clock skew makes a locally-"valid" token rejected by the server] → 60s early-refresh buffer; the eventual API client treats a 401 as a refresh trigger (future change).
- [User's Auth0 app misconfigured (grant types, offline access)] → Auth0 returns descriptive `error_description` on the device-code request; surface it verbatim.

## Open Questions

- None — design choices were settled in the preceding discussion (offline_access confirmed, hand-rolled fetch confirmed, whoami local-only).
