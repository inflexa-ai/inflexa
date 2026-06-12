## 1. Environment configuration

- [x] 1.1 Add `auth0Domain`, `auth0ClientId`, `auth0Audience` (from `INF_AUTH0_DOMAIN`/`INF_AUTH0_CLIENT_ID`/`INF_AUTH0_AUDIENCE`, all `string | undefined`) and `authPath` (`{configDir}/inf/auth.json`) to `src/lib/env.ts` (Auth0 reads later moved to `bakedEnv` and dropped from `envDoc` — see group 5)

## 2. Auth session layer (`src/lib/auth.ts`)

- [x] 2.1 Define domain types: `StoredAuth`, `DeviceCodeResponse`, token response shapes, and the `AuthError` discriminated union (`missing_config`, `not_authenticated`, `device_code_request_failed`, `authorization_expired`, `authorization_denied`, `refresh_failed`, `revoke_failed`, `token_read_failed`, `token_write_failed`)
- [x] 2.2 Implement Auth0 config resolution that returns `missing_config` listing every unset `INF_AUTH0_*` var
- [x] 2.3 Implement token persistence: `loadAuth`/`saveAuth`/`deleteAuth` with `0600` perms and atomic write (temp file + rename), all returning `Result`
- [x] 2.4 Implement `requestDeviceCode()` — form-encoded POST to `/oauth/device/code` with scope `openid profile email offline_access` + audience, surfacing Auth0's `error_description` on failure
- [x] 2.5 Implement `pollForToken()` — interval polling of `/oauth/token` with device-code grant, classifying by body `error` field (`authorization_pending` continue, `slow_down` +5s, `expired_token`/`access_denied`/deadline → typed errors)
- [x] 2.6 Implement `refreshAccessToken()` (refresh-token grant, persists rotated refresh token before returning) and `getValidAccessToken()` (returns stored token when >60s left, else refreshes; `not_authenticated` when no file)
- [x] 2.7 Implement `revokeRefreshToken()` — POST `/oauth/revoke`, `Result`-returning so logout can treat failure as non-fatal

## 3. CLI commands

- [x] 3.1 Implement `src/cli/login.ts` — print verification URL + code, best-effort browser open via `Bun.spawn` (platform-specific, failures ignored), poll, save, print success with expiry; non-zero exit on missing config/denied/expired
- [x] 3.2 Implement `src/cli/logout.ts` — best-effort revoke (warn on failure), always delete `auth.json`, idempotent zero exit including the no-tokens case
- [x] 3.3 Implement `src/cli/whoami.ts` — base64url-decode ID token payload, print `sub`/`email`/`name` + session status (valid / renews-on-next-use); "Not logged in" + non-zero exit when no tokens; no network
- [x] 3.4 Register the three commands in `src/cli/index.ts` with lazy imports, matching existing command style

## 4. Verification

- [x] 4.1 Run `bun run typecheck` and `bun run lint` (confirms `env.ts` remains the sole `process.env` reader) and fix any findings
- [x] 4.2 Verify `inf --help` lists the three commands and the auth token path (the `INF_AUTH0_*` vars were initially listed, then removed by group 5 — internal config)
- [x] 4.3 Manually exercise the no-config and not-logged-in paths (`inf login` without env vars → names missing vars; `inf whoami`/`inf logout` without tokens → specified messages and exit codes)
- [x] 4.4 Run `bun run format:file` on all touched `src/` files

## 5. Compile-time baked configuration

- [x] 5.1 Move the three Auth0 reads from `env` into a frozen `bakedEnv` object in `env.ts` using literal `process.env.<NAME>` dot access (required for bundler inlining); drop their `envDoc` entries so `--help` no longer lists them
- [x] 5.2 Point `resolveAuth0Config` at `bakedEnv` and reword the missing-config message to cover baked release builds vs dev
- [x] 5.3 Add `scripts/build.ts` (`bun run build`): fail fast on unset baked vars, inline each via `define` into `Bun.build({ compile })` with the opentui Solid plugin (state reset to avoid the bunfig preload's virtual-module resolvePath), `bunfig.toml`/`.env` runtime autoload disabled in the compiled binary
- [x] 5.4 Verify with a real compiled binary: baked literals embedded, cleared-env run does not report missing config, runtime `INF_AUTH0_*` overrides ignored, vars absent from `--help`
- [x] 5.5 Derive the baked-var list in `scripts/build.ts` from the `bakedEnv` block in `env.ts` (scan for literal `process.env.<NAME>` accesses) so adding a dot access there is the entire procedure; verified with a probe var (build fails naming it when unset, inlines it when set)
- [x] 5.6 Post-build smoke test in `scripts/build.ts`: run the host binary with `--version` and fail the build if it cannot start (pattern borrowed from opencode's build script)
- [x] 5.7 Cross-compile target matrix in `scripts/build.ts`: `bun run build` = host only, `bun run build:all` = darwin-arm64, darwin-x64, linux-x64, windows-x64; installs all `@opentui/core` platform packages before cross-building, bakes `OPENTUI_LIBC=glibc` on linux, smoke-tests only the host target; verified all four binaries (Mach-O arm64/x86_64, ELF x86-64, PE32+) with baked values embedded

## 6. Zod boundary validation

- [x] 6.1 Add the `zod` dependency (explicitly approved)
- [x] 6.2 Replace the Auth0 wire types and the generic `parseJson` cast in `src/lib/auth.ts` with zod schemas + a `parseWith(schema, raw)` helper; derive `StoredAuth`/`TokenWire` via `z.infer`
- [x] 6.3 Validate `auth.json` loads against the `StoredAuth` schema (replaces the hand-rolled `isStoredAuth` guard)
- [x] 6.4 Validate decoded ID-token claims in `src/cli/whoami.ts` with a zod schema (unknown claims stripped)
- [x] 6.5 Validate `config.json` in `src/lib/config.ts` with a zod schema; derive `Config` via `z.infer`
- [x] 6.6 Re-run typecheck/lint and the behavioral checks (valid + malformed `auth.json`, extra claims, config with unknown keys)
