## Why

A 2026-07-13 audit found the committed `.env.example` audience value was not an API identifier at all (a credential-shaped value had been pasted into the wrong slot — since corrected), and the working dev value pointed at the Auth0 Management API — an audience that can never issue refresh tokens (`allow_offline_access` is immutably false), so `inflexa auth login` cannot complete its sliding-session design. Nothing in the CLI rejects a nonsensical audience today: any non-empty string passes `resolveAuth0Config` and, worse, bakes silently into release binaries. A dedicated resource server (identifier `https://api.inflexa.ai`) is being created in the tenant; the CLI must point at it and refuse the whole class of paste-the-wrong-field config errors.

## What Changes

- `.env.example` gets the dedicated API identifier (`https://api.inflexa.ai`) as `INFLEXA_AUTH0_AUDIENCE`, replacing the rotated-secret garbage value.
- `resolveAuth0Config` validates the audience's shape: a value that does not parse as a URI is rejected with a new typed `AuthError` variant (naming the offending var and why), so both `bun run dev` (runtime env) and a baked release value are covered by the same guard. A secret-shaped blob or empty-scheme string can no longer reach the device-code request and fail as an opaque Auth0 `Service not found`.
- The `auth-session` spec's Auth0-configuration requirement is amended to (a) require the audience to be the dedicated product API identifier — a URI, never the Auth0 Management API (`…/api/v2/`) — and (b) record the tenant prerequisites the flow depends on: Device Code + Refresh Token grants on the application, Allow Offline Access on the API, rotating refresh tokens with ~30-day inactivity expiry.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `auth-session`: the "Auth0 configuration" requirement gains audience shape validation (URI-or-typed-error, covering dev and baked values) and the explicit tenant-prerequisite contract (dedicated API identifier, never the Management API; offline access + rotating refresh tokens with 30-day inactivity).

## Impact

- `src/modules/auth/auth.ts` — `resolveAuth0Config`, the `AuthError` union, and `describeAuthError` gain the invalid-audience variant.
- `src/modules/auth/auth.test.ts` — truth-table coverage for the new guard.
- `.env.example` — audience line replaced.
- `openspec/specs/auth-session/spec.md` — via this change's delta spec.
- No new dependencies (`URL.canParse` / `new URL` is in-runtime). No behavior change for any command that does not use Auth0.
- Coordination: the real tenant object is created out of band; this change is implementable immediately (the guard and spec don't depend on the tenant), and `.env.example` carries the agreed identifier.
