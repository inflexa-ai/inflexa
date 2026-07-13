## Context

`resolveAuth0Config` (`src/modules/auth/auth.ts`) accepts any non-empty string for `INFLEXA_AUTH0_AUDIENCE`, and `scripts/build.ts` bakes whatever value the build environment holds (its guard only rejects *unset* vars). Both permissiveness points were exercised by a real incident: the committed `.env.example` carried the application's client secret in the audience slot (a paste error — any non-empty string passed), and the working dev value pointed at the Auth0 Management API, whose `allow_offline_access` is immutably false, making the sliding-session design (`tokenWireToStoredAuth` requires a refresh token) impossible to satisfy. The correct target is a dedicated resource server, identifier `https://api.inflexa.ai` (created under inflexa-ai/nexus#143).

Auth0's failure modes for a bad audience are opaque from the CLI's seat: an unregistered value fails at `/oauth/device/code` with `Service not found: <blob>`, and the Management API value fails only *after* browser approval, as a missing refresh token. Both should be caught before any network call, as a config error naming the variable.

## Goals / Non-Goals

**Goals:**

- Reject a malformed or known-wrong audience before the device-code request, with a typed `AuthError` a user can act on.
- Cover every path a bad value can arrive by: dev runtime env / `.env`, and a baked release value.
- Make the release build refuse to *produce* a binary with a mis-shapen audience (operator-visible failure, before shipping).
- Point `.env.example` at the dedicated API identifier.

**Non-Goals:**

- Validating `INFLEXA_AUTH0_DOMAIN` / `INFLEXA_AUTH0_CLIENT_ID` shapes — the domain fails naturally when the URL is built, and client IDs carry no shape contract worth encoding. Only the audience has a demonstrated misconfiguration class.
- Verifying the audience is *registered* in the tenant (requires a network call; Auth0's `Service not found` already covers it at first use).
- Tenant-side work (resource-server creation, app grant/rotation settings) — tracked in inflexa-ai/nexus#143; this change only encodes the prerequisites in the spec.

## Decisions

**1. The guard is a pure predicate used at two gates: runtime (`resolveAuth0Config`) and build (`scripts/build.ts`).**
Runtime-only would let a bad bake ship and break every user's `auth login` on their machine; build-only would miss `bun run dev` and hand-rolled builds. The repo already has this exact dual-gate idiom for `INFLEXA_GIT_COMMIT` (build.ts refuses where the operator can see it; `env.ts`'s `resolveGitCommit` keeps a runtime backstop). The predicate lives in `auth.ts` beside `resolveAuth0Config` and is imported by `build.ts` — one truth table, two gates. Alternative rejected: duplicating the check inline in build.ts (two truth tables that drift).

**2. Valid = parses as a URI, and is not the tenant's own Management API audience.**
`URL.canParse(audience)` is the shape test: Auth0 API identifiers are conventionally URIs, ours is `https://api.inflexa.ai`, and every observed failure value (a base64url secret blob) has no scheme and fails the parse. Any scheme is accepted (a `urn:` identifier is legitimate) — this is a shape check, not an allowlist. The second clause rejects `https://<INFLEXA_AUTH0_DOMAIN>/api/v2/` exactly (string-compared against the *configured* domain, so unrelated third-party APIs with `/api/v2/` paths cannot false-positive): pointing at the Management API is the other misconfiguration that actually happened, it can never work (no refresh tokens), and the failure it produces otherwise (post-approval, missing refresh token) is the most confusing in the flow. Alternative rejected: `https:`-only validation — over-constrains legitimate identifier schemes for zero added safety.

**3. One new `AuthError` variant, `invalid_audience`, with a `reason` discriminant (`not_a_uri` | `management_api`) and a truncated echo of the value.**
One variant keeps `describeAuthError` and callers simple while the `reason` picks the message (paste error vs wrong-API guidance). The echoed value is truncated (first 12 chars + `…`): the not-a-URI case exists precisely because secrets get pasted here, and the error message must not replay a full credential into terminal scrollback or logs.

**4. Build-gate placement: after the missing-var loop in `build.ts`, before any compile.**
Same operator-facing position and tone as the existing missing-var / channel / commit gates. It validates `process.env.INFLEXA_AUTH0_AUDIENCE` against the same predicate plus the Management-API check using `process.env.INFLEXA_AUTH0_DOMAIN` (both are guaranteed present by the missing-var loop just above).

## Risks / Trade-offs

- [A legitimate future identifier that is not a URI would be rejected] → Accepted deliberately: the spec (amended by this change) pins the identifier contract to a URI; loosening it is a spec change, which is the right friction.
- [The Management-API rejection encodes tenant policy in code] → Scoped to the one value that is *provably* unusable for this flow (no refresh tokens, ever) and derived from the configured domain rather than a hardcoded tenant string, so it holds for any tenant the binary is built against.
- [`.env.example` names an identifier that doesn't exist in the tenant yet] → Login fails with Auth0's `Service not found` until nexus#143 lands — identical to today's behavior, but now with a value that becomes correct the moment the tenant catches up.

## Migration Plan

1. Land the guard + spec + `.env.example` (this change; safe immediately — nothing depends on the tenant).
2. After the resource server exists (nexus#143): devs update local `.env` audience; release builds set the new value in the build environment.
3. No stored-state migration: `auth.json` is untouched; no currently-working sessions exist to preserve (login is broken today under both known values). First login against the new audience establishes a fresh grant.

## Open Questions

- None blocking. The identifier string is agreed as `https://api.inflexa.ai`; if nexus#143 settles on a different final identifier, only `.env.example` and build env values change — the guard is value-agnostic by design.
