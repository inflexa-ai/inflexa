# Proposal

## Why

A browser cannot sign in to the local server in a way that a new tab keeps. Each `/api/*` request needs the bearer token of the discovery file, and the dev page `/gui/` gets the token from the URL fragment. Thus each new tab needs the link again, and the scripts of the page hold the token. An `<img>` or an `<iframe>` cannot send a header, thus a later route for the bytes of a workspace file (issue #636) needs a different credential.

## What Changes

- New route `POST /api/v1/session/nonce`. With the bearer token, it gives a one-time nonce with a short life.
- New route `GET /api/v1/session?nonce=<nonce>&next=<path>`. It uses the nonce, sets an `HttpOnly`, `SameSite=Strict` session cookie, and redirects to `next`. This route is the one route under `/api/` that needs no bearer token.
- Each other route under `/api/` accepts the bearer token or a valid session cookie. The cookie holds a random session secret of its own, not the bearer token. The server keeps the sessions in memory only. Thus a restart of the server makes each old cookie get 401, and the message tells the person to run `inflexa gui` again.
- New command `inflexa gui`, in each build. It gets a nonce from the server and opens the sign-in link for `/gui/` in the default browser. Its agent policy is `blocked`: only a person can run it.
- **BREAKING** `/gui/` serves a plain HTML page with the content "Not implemented", in each build. The proof-of-concept page and its token fragment go away. The `guiEnabled` flag of the app and its gate go away.
- **BREAKING** `bun scripts/poc_gui.ts` goes away. `inflexa gui` replaces it.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-server`: the bearer requirement accepts a session cookie as the alternative credential. New requirements give the browser sign-in (the nonce route, the session route, and the cookie) and `inflexa gui`. A placeholder page in each build replaces the dev-channel web page. The route groups get the sign-in group, and the Host check runs before the credential check.
- `dev-commands`: the list of the production command surface gets `gui`. The list also gets `sbom`, which is a release command (`src/cli/index.ts:1129`) that the list does not name today.

## Impact

- Server code: `src/server/app.ts` gets the credential check and the mount of the session routes, and it loses `AppOpts.guiEnabled`. The session routes and the in-memory session store go under `src/server/`. `src/server/routes/gui.ts` serves the placeholder page.
- Client code: new wire types under `src/api/`, a new fetcher and command action under `src/client/`, and the registration in `src/cli/index.ts`.
- Removed: `src/server/gui/poc.html`, `scripts/poc_gui.ts`, and `scripts/poc_gui.test.ts`.
- Tests: `src/server/app.test.ts`, new tests for the session routes and the command, and the snapshot of `src/cli/agent_policy_tree.test.ts`.
- Docs: the "The local server" section of `cli/CLAUDE.md` names `inflexa gui` in place of the script.
- No new dependency: `hono/cookie` comes with the installed Hono.
- The TUI and the other commands keep the bearer token, with no change.
