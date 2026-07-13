## 1. Audience validity predicate + runtime gate

- [x] 1.1 Add the pure audience-validity predicate beside `resolveAuth0Config` in `src/modules/auth/auth.ts`: valid iff the value parses as a URI (`URL.canParse`, any scheme) AND does not equal `https://{domain}/api/v2/` for the configured domain; returns the failure reason (`not_a_uri` | `management_api`) so both gates render it
- [x] 1.2 Add the `invalid_audience` variant to `AuthError` (`{ type: "invalid_audience"; variable: "INFLEXA_AUTH0_AUDIENCE"; reason: "not_a_uri" | "management_api"; valuePrefix: string }` — `valuePrefix` truncated to ~12 chars so a pasted credential is never echoed in full) and wire `resolveAuth0Config` to reject via the predicate after the missing-var check
- [x] 1.3 Extend `describeAuthError` with actionable messages per reason: `not_a_uri` → "not an API identifier (URI) — check the value pasted into INFLEXA_AUTH0_AUDIENCE"; `management_api` → "the Auth0 Management API cannot be the product audience (it never issues refresh tokens) — use the dedicated API identifier"

## 2. Build gate

- [x] 2.1 In `scripts/build.ts`, after the missing-var loop (both vars guaranteed present there), validate `process.env.INFLEXA_AUTH0_AUDIENCE` with the same predicate imported from `auth.ts`; on failure, print the variable name + reason and `process.exit(1)` before any compile, matching the tone of the existing missing-var/channel/commit gates

## 3. Config value

- [x] 3.1 Replace `INFLEXA_AUTH0_AUDIENCE` in `.env.example` with `https://api.inflexa.ai` (the dedicated resource-server identifier from inflexa-ai/nexus#143)

## 4. Tests

- [x] 4.1 In `src/modules/auth/auth.test.ts`, cover the predicate truth table: valid `https:` URI passes; valid non-`https` scheme (e.g. `urn:inflexa:api`) passes; scheme-less blob (secret-shaped base64url) fails `not_a_uri`; `https://{domain}/api/v2/` fails `management_api`; an unrelated API whose path contains `/api/v2/` on a different host passes
- [x] 4.2 Cover `resolveAuth0Config`: missing vars still win (missing-config error listing vars) and a present-but-invalid audience returns `invalid_audience` with the truncated `valuePrefix` (assert the full value is NOT present in the error or its description)

## 5. Verify

- [x] 5.1 Run `bun run typecheck`, `bun run lint`, `bun test src/modules/auth/` from `cli/`, and `bun run format:file` on the touched `src/` files
- [x] 5.2 Drive the runtime gate end-to-end: `INFLEXA_AUTH0_AUDIENCE=<blob> bun run dev auth login` prints the invalid-audience message without any network request; same with the Management API value prints the wrong-API message
- [x] 5.3 Drive the build gate: `bun run build` with a mis-shapen `INFLEXA_AUTH0_AUDIENCE` fails before compiling, naming the variable and reason
