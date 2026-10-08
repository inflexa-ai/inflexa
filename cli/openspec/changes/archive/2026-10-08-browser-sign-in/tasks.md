# Tasks

## 1. The session store and the credential check

- [x] 1.1 Add the wire type of the nonce response (`{ nonce, expiresAt }`) in `src/api/browser_session.ts`. Make sure that `bun run typecheck` passes.
- [x] 1.2 Add the in-memory store of nonces and sessions in `src/server/browser_session.ts` (design D2): SHA-256 digests, a nonce life of 60 s, a bound of 32 for each kind with the oldest out first, and the clock from `AppOpts.now`. Add unit tests for a one-time nonce, an expired nonce, the bound, and an unknown session.
- [x] 1.3 Replace `bearerAuth` in `src/server/app.ts` with the credential middleware of design D4. It holds the pass of `GET /api/v1/session`, the bearer token, and the cookie with the `Sec-Fetch-Site` rule. It puts the credential kind in `ServerEnv`. Its 401 message names `inflexa gui` for a session cookie that is not valid. Extend `src/server/app.test.ts` for each branch. Include `POST /api/v1/session`, `GET /api/v1/session/`, and `GET /api/v1/session/nonce` with no credential, which get 401. Make sure that the bearer tests still pass.

## 2. The session routes

- [x] 2.1 Add `src/server/routes/browser_session.ts`, mounted at `/api/v1/session` (design D5). `POST /nonce` answers 201 for the bearer token and 403 `forbidden` for the credential kind `cookie`. `GET /` reads `next` first, then uses the nonce, sets the cookie of design D3, and answers 303 with `Cache-Control: no-store`.
- [x] 2.2 Add a route test for each scenario of the local-server requirement "A browser signs in with a one-time link". A restart is a new app that refuses the old cookie. Also assert that the cookie value is not the bearer token and does not hold it, and that a `next` with a CR and an LF gets 400 with the nonce usable. Make sure that each test passes.

## 3. The placeholder page

- [x] 3.1 Make `src/server/routes/gui.ts` give the inline "Not implemented" HTML page (design D7). Remove `src/server/gui/poc.html`. Remove `AppOpts.guiEnabled` and its gate, so that `buildApp` always mounts `/gui` and `/gui/`. Update the web GUI tests of `src/server/app.test.ts`: the page needs no credential, `/gui` gives 301 to `/gui/`, and the default app serves the page.

## 4. The `inflexa gui` command

- [x] 4.1 Add the fetcher `src/client/browser_session.ts` for `POST /api/v1/session/nonce`, and the action `src/client/commands/gui.ts` of design D6. The action reads the discovery one time, prints the link, and calls `openExternal`. Add unit tests for the link (the base URL of the discovery, the nonce, and `next=/gui/`), for an open that succeeds, and for an open that fails.
- [x] 4.2 Register `inflexa gui` in `src/cli/index.ts`, outside the dev gate, as an `instance` command with the description of design D6, the policy `blocked`, and a reason for the agent. In `src/cli/agent_policy_tree.test.ts`, add `inflexa gui` as `blocked` to `EXPECTED_DEV_OFF` and `EXPECTED_DEV_ON`, and as `instance` to `EXPECTED_KINDS`. This snapshot is the test of the spec scenario "The agent cannot run the command". Make sure that the test passes.

## 5. Remove the proof-of-concept script and update the docs

- [x] 5.1 Remove `scripts/poc_gui.ts` and `scripts/poc_gui.test.ts`. Make sure that no file of `cli/` names `poc_gui` or `poc.html` with a search.
- [x] 5.2 In the "The local server" section of `cli/CLAUDE.md`, change the "The dev web page" item to name the placeholder page at `/gui/` in each build and the sign-in of `inflexa gui`. In the `src/server/` item of "Project structure", change "its bearer check" to "its credential check". Make sure that a search for `poc_gui` in `cli/CLAUDE.md` finds nothing.

## 6. Verification

- [x] 6.1 Run `bun run format:file` on the changed files of `src/`. Then run `bun run typecheck`, `bun run lint`, and the changed test files. Make sure that each one passes.
- [x] 6.2 Run `bun scripts/gen_docs.ts` one time, and make sure that it succeeds with `gui` in the generated reference.
- [x] 6.3 Run the full suite of cli one time with `bun run test`, and make sure that it passes.
