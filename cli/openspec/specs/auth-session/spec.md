# auth-session Specification

## Purpose
The headless Auth0 device-authorization session layer — config baking, device-code initiation, token polling, atomic token persistence, transparent refresh with cross-process locking, revocation, and schema-validated, Result-typed boundaries.

## Requirements

### Requirement: Auth0 configuration

Auth0 settings (`INFLEXA_AUTH0_DOMAIN`, `INFLEXA_AUTH0_CLIENT_ID`, `INFLEXA_AUTH0_AUDIENCE`) SHALL be read exclusively through the `bakedEnv` object in `src/lib/env.ts`, using literal `process.env.<NAME>` member access so that release builds (`bun run build`) can inline them as compile-time constants; dev runs fall back to the runtime environment through the same expressions. They are internal configuration: they SHALL NOT appear in `envDoc`/`--help`, and a compiled binary SHALL NOT be influenced by their runtime values. No client secret SHALL exist anywhere (public client). Auth operations that need this config SHALL fail with a typed error naming every missing variable; commands that do not use Auth0 SHALL be unaffected by their absence.

`INFLEXA_AUTH0_AUDIENCE` SHALL be the identifier of the dedicated product API (resource server) — a URI (e.g. `https://api.inflexa.ai`) — and SHALL NOT be the tenant's Auth0 Management API audience (`https://{INFLEXA_AUTH0_DOMAIN}/api/v2/`), which can never issue refresh tokens and therefore cannot satisfy the sliding-session requirements below. The same audience-validity predicate SHALL be enforced at both gates: `resolveAuth0Config` SHALL reject an audience that does not parse as a URI, or that equals the configured domain's Management API audience, with a typed error that names the variable and echoes at most a truncated prefix of the offending value (the not-a-URI case exists because credentials get pasted into this slot; the message must not replay one in full); `bun run build` SHALL refuse to produce a binary whose audience fails that same predicate, before compiling.

The flow additionally depends on tenant configuration outside this repository, which SHALL hold for any tenant the binary is built against: the application is a public native client with the Device Code and Refresh Token grants; the product API has Allow Offline Access enabled; refresh tokens are rotating with an inactivity expiry of ~30 days (the sliding session's window).

#### Scenario: Missing configuration (dev build)

- **WHEN** an auth operation runs in dev and `INFLEXA_AUTH0_DOMAIN` and `INFLEXA_AUTH0_AUDIENCE` are unset
- **THEN** it returns a config error listing exactly `INFLEXA_AUTH0_DOMAIN` and `INFLEXA_AUTH0_AUDIENCE`

#### Scenario: Audience is not a URI

- **WHEN** an auth operation runs with `INFLEXA_AUTH0_AUDIENCE` set to a value that does not parse as a URI (e.g. a pasted credential blob)
- **THEN** it returns a typed invalid-audience error naming `INFLEXA_AUTH0_AUDIENCE`, carrying at most a truncated prefix of the value, before any network request is made

#### Scenario: Audience is the Management API

- **WHEN** an auth operation runs with `INFLEXA_AUTH0_AUDIENCE` equal to `https://{INFLEXA_AUTH0_DOMAIN}/api/v2/`
- **THEN** it returns a typed invalid-audience error explaining the Management API cannot serve as the product audience (no refresh tokens), before any network request is made

#### Scenario: Baked values cannot be overridden

- **WHEN** a release binary built with baked Auth0 values runs with different `INFLEXA_AUTH0_*` values in its environment
- **THEN** the baked values are used and the runtime environment is ignored

#### Scenario: Release build refuses incomplete configuration

- **WHEN** `bun run build` runs with any baked variable unset
- **THEN** the build fails before compiling, naming the missing variable(s)

#### Scenario: Release build refuses a mis-shapen audience

- **WHEN** `bun run build` runs with `INFLEXA_AUTH0_AUDIENCE` set to a value that fails the audience-validity predicate (not a URI, or the Management API audience)
- **THEN** the build fails before compiling, naming `INFLEXA_AUTH0_AUDIENCE` and the reason

#### Scenario: Newly baked variable is picked up automatically

- **WHEN** a new `process.env.<NAME>` dot access is added to `bakedEnv` and `bun run build` runs without `<NAME>` set
- **THEN** the build fails naming `<NAME>`, with no change to the build script (the baked set is derived from the `bakedEnv` source)

#### Scenario: Other commands unaffected

- **WHEN** `inflexa sessions` runs with no `INFLEXA_AUTH0_*` variables set
- **THEN** it works exactly as before

### Requirement: Device authorization initiation

The session layer SHALL request a device code via `POST https://{INFLEXA_AUTH0_DOMAIN}/oauth/device/code` (form-encoded) with `client_id`, `audience`, and scope `openid profile email offline_access`.

#### Scenario: Successful initiation

- **WHEN** the request succeeds
- **THEN** the parsed response provides `device_code`, `user_code`, `verification_uri_complete`, `expires_in`, and `interval` for the polling phase

#### Scenario: Initiation rejected

- **WHEN** Auth0 responds with a non-200 status (e.g. device grant not enabled on the application)
- **THEN** a typed error is returned carrying Auth0's `error_description` verbatim

### Requirement: Token polling

The session layer SHALL poll `POST https://{INFLEXA_AUTH0_DOMAIN}/oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code` every `interval` seconds until a token arrives or `expires_in` elapses. Outcomes SHALL be classified by the `error` field of the JSON response body, never by HTTP status (Auth0 deviates from RFC 8628 statuses). A single transient failure (network error, request timeout, or unparseable body) SHALL NOT abort the flow: such failures SHALL be retried on subsequent intervals up to a small budget of *consecutive* failures, reset by any valid response, with the `expires_in` deadline still bounding the overall wait.

#### Scenario: Authorization pending

- **WHEN** a poll returns `error: "authorization_pending"`
- **THEN** polling continues at the current interval

#### Scenario: Slow down

- **WHEN** a poll returns `error: "slow_down"`
- **THEN** the polling interval increases by 5 seconds before the next attempt

#### Scenario: Transient failure mid-poll

- **WHEN** a poll attempt cannot reach Auth0 (network error or request timeout) or returns an unparseable body, but fewer than the consecutive-failure budget have occurred in a row
- **THEN** polling retries on the next interval instead of aborting; only once the budget is exhausted (or `expires_in` passes) is a typed poll-failure error returned

#### Scenario: User approves

- **WHEN** a poll returns a token response with no `error`
- **THEN** polling stops and the response's `access_token`, `refresh_token`, `id_token`, and `expires_in` are returned

#### Scenario: Device code expires

- **WHEN** a poll returns `error: "expired_token"` or the `expires_in` deadline passes
- **THEN** a typed expiry error is returned

#### Scenario: User denies

- **WHEN** a poll returns `error: "access_denied"`
- **THEN** a typed denial error is returned

### Requirement: Token persistence

Tokens SHALL be persisted as JSON (`accessToken`, `refreshToken`, `idToken`, `expiresAt` as ISO-8601 computed from `expires_in`) at the auth path exposed by `env.ts` (`{configDir}/inflexa/auth.json`), created with `0600` permissions, written atomically (write temp file, then rename) so a crash mid-write cannot corrupt or strand stale credentials.

#### Scenario: First save

- **WHEN** tokens are saved and the parent directory does not exist
- **THEN** the directory is created and `auth.json` exists afterward with mode `0600`

#### Scenario: Load without prior login

- **WHEN** tokens are loaded and `auth.json` does not exist
- **THEN** a typed `not_authenticated` error is returned (not a thrown exception)

### Requirement: Transparent access token refresh

`getValidAccessToken()` SHALL be the sole public read path for the access token. It SHALL return the stored token when it has more than 60 seconds of validity left; otherwise it SHALL exchange the refresh token via `POST /oauth/token` with `grant_type=refresh_token` and persist the full response — including the newly rotated refresh token — before returning the new access token. Because refresh tokens rotate, refreshes SHALL be serialized across concurrent processes by a cross-process advisory lock, and a process that waited on the lock SHALL re-read the stored token and reuse it when it is now valid rather than presenting its own already-rotated refresh token (which would trip Auth0 reuse-detection and revoke the grant family). A crashed lock holder SHALL NOT wedge refreshes permanently: a sufficiently old lock SHALL be reclaimed.

#### Scenario: Token still valid

- **WHEN** the stored access token expires more than 60 seconds from now
- **THEN** it is returned with no network request

#### Scenario: Token expired, refresh succeeds

- **WHEN** the stored access token is within 60 seconds of expiry and the refresh request succeeds
- **THEN** the new access token is returned and `auth.json` now contains the new access token, new expiry, and the rotated refresh token from the response

#### Scenario: Refresh fails

- **WHEN** the refresh request is rejected (revoked, expired by inactivity, or reuse-detected)
- **THEN** a typed `refresh_failed` error is returned whose message tells the user to run `inflexa auth login`

#### Scenario: Never logged in

- **WHEN** `getValidAccessToken()` is called with no stored tokens
- **THEN** a typed `not_authenticated` error is returned

#### Scenario: Concurrent refresh across processes

- **WHEN** two inflexa processes both find the stored access token within 60 seconds of expiry at the same time
- **THEN** one acquires the refresh lock and rotates the token while the other waits, and the waiter then re-reads the freshly persisted token and returns it without a second refresh request — so the rotated refresh token is never replayed and the grant family is not revoked

#### Scenario: Crashed lock holder

- **WHEN** a refresh lock file is left behind by a process that died mid-refresh
- **THEN** a later refresh reclaims the stale lock once it is older than the holder's bounded lifetime, rather than waiting forever or failing

### Requirement: Refresh token revocation

The session layer SHALL expose revocation via `POST https://{INFLEXA_AUTH0_DOMAIN}/oauth/revoke` (form-encoded `client_id` + `token` = the stored refresh token), returning a `Result` so callers decide whether failure is fatal.

#### Scenario: Successful revocation

- **WHEN** revocation is requested with a stored refresh token and Auth0 returns 200
- **THEN** an ok result is returned and the entire grant family is invalid server-side

#### Scenario: Revocation fails

- **WHEN** the revoke request fails (network down, token already revoked)
- **THEN** an error result is returned without throwing, leaving the caller free to continue

### Requirement: Schema-validated JSON boundaries

Every JSON payload entering the auth layer from outside the process SHALL be validated against a zod schema before any field is used: Auth0 wire responses (device-code, token, error bodies), the stored `auth.json`, and decoded ID-token claims. TypeScript types for these shapes SHALL be derived from their schemas (`z.infer`), and validation failure SHALL map to the operation's typed error — never an exception or a blindly cast object.

#### Scenario: Malformed Auth0 response

- **WHEN** an Auth0 endpoint returns JSON that does not match the expected wire schema
- **THEN** the operation returns its typed failure carrying the raw payload for diagnosis

#### Scenario: Malformed stored token file

- **WHEN** `auth.json` exists but fails schema validation (e.g. a field has the wrong type)
- **THEN** loading returns a `token_read_failed` error stating the file is malformed

#### Scenario: Unknown ID-token claims are ignored

- **WHEN** a stored ID token carries claims beyond `sub`/`email`/`name`
- **THEN** decoding succeeds and the extra claims are stripped

### Requirement: Result-typed errors

All fallible auth-session operations SHALL return neverthrow `Result`/`ResultAsync` values with a discriminated `AuthError` union (no thrown exceptions across the module boundary), consistent with the existing `result-types` capability.

#### Scenario: Error consumed by a command

- **WHEN** a command invokes any auth-session operation that fails
- **THEN** it receives a typed error variant it can `.match()` on to print a friendly message
