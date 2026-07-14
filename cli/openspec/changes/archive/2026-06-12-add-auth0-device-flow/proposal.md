## Why

inf-cli has no authentication: it cannot identify the user or call the Nexus server's protected API. We need users to log in once via Auth0 and then keep working daily without re-authenticating — the same UX as Claude Code, where a long sliding session renews itself as long as the tool is used.

## What Changes

- New top-level CLI commands: `inf login`, `inf logout`, `inf whoami`.
- `login` runs the Auth0 Device Authorization Flow (RFC 8628) hand-rolled with `fetch` — no new dependencies. It prints a verification URL + user code, best-effort opens the browser, polls for tokens, and persists them.
- Tokens are requested with `openid profile email offline_access` scope plus the API audience, so the response includes a rotating refresh token. Access tokens are transparently refreshed before expiry; each refresh persists the newly rotated refresh token.
- `logout` best-effort revokes the refresh-token grant at Auth0, then deletes the local token file.
- `whoami` decodes the stored ID token locally (no network call) and prints identity + session status.
- Three internal configuration values read via `src/lib/env.ts`: `INF_AUTH0_DOMAIN`, `INF_AUTH0_CLIENT_ID`, `INF_AUTH0_AUDIENCE` (public client — no secret). Release binaries bake them in at compile time (`bun run build`); dev runs fall back to runtime env/`.env`. They are deliberately absent from `--help` — they are internal, not user-tweakable.
- New token file `auth.json` in the user config dir (alongside `config.json`), written with `0600` permissions.
- All JSON crossing a trust boundary is schema-validated with zod instead of hand-rolled narrowing: Auth0 wire responses, the stored `auth.json`, decoded ID-token claims, and the existing `config.json` read. Types derive from the schemas (`z.infer`), making each schema the single source of truth.

## Capabilities

### New Capabilities

- `auth-session`: Auth0 device-flow token lifecycle — acquiring tokens via device authorization, persisting them securely, transparent refresh with rotation, and revocation. The shared layer that commands (and later the chat backend) consume.
- `auth-commands`: the `login`, `logout`, and `whoami` CLI commands — user-facing flows, output, and error behavior.

### Modified Capabilities

<!-- none — no existing spec's requirements change -->

## Impact

- New file `src/lib/auth.ts` (token store + device flow + refresh); new command files `src/cli/login.ts`, `src/cli/logout.ts`, `src/cli/whoami.ts`; command registration in `src/cli/index.ts`; env additions in `src/lib/env.ts`.
- New release build script `scripts/build.ts` (`bun run build`): compiles a single executable via `Bun.build` with the Auth0 values inlined as compile-time constants.
- One new dependency, explicitly approved: `zod` (boundary validation). Everything else uses built-ins (`fetch`, `node:fs`, `Bun.spawn`); errors follow the existing neverthrow `Result` convention. No Auth0 SDK.
- Requires Auth0 tenant config (outside this repo): Native app, Device Code + Refresh Token grants, API audience with Allow Offline Access, refresh-token rotation with ~30-day inactivity lifetime.
- Deliberate divergence from a sibling admin CLI: it forbids `offline_access` because it is a high-privilege tool; inf-cli is user-facing and requires it.
