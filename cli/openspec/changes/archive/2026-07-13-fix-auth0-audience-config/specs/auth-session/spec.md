## MODIFIED Requirements

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
