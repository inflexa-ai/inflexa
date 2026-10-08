# Design

## Context

- `buildApp` (`src/server/app.ts`) puts the Host and Origin check on each path, then `bearerAuth(token)` on each `/api/*` path. `serve.ts` makes the token and gives it to `buildApp`.
- The `/gui/` page and the `/gui` redirect mount only when `AppOpts.guiEnabled()` is true. In production that is `devCommandsEnabled`.
- The local-server spec says that the server writes the token only to the discovery file.
- The client side reaches the server through `src/client/api.ts`. A discovery gives `{ baseUrl, token }`. `src/lib/open_external.ts` (`openExternal`) is the one opener of the OS, and each caller prints the target when the open fails.
- Hono `^4.12.34` has `hono/cookie` (`getCookie`, `setCookie`). The change adds no dependency.

## Goals / Non-Goals

**Goals:**

- One credential check for `/api/*` that accepts the bearer token or a session cookie.
- A sign-in that a browser does one time for each server start.
- A `/gui/` target that each build serves.

**Non-Goals:**

- A web UI. `/gui/` is a placeholder page.
- A sign-out route, an expiry of a session before the server stops, or a session that outlives a restart.
- An `--origin` option for a dev proxy. The sign-in route is under `/api`, thus a proxy of `/api` can forward it later.
- The route for the bytes of a workspace file (#636). It uses the cookie later.

## Decisions

### D1. The cookie holds a session secret, not the bearer token

The server makes a new random 256-bit secret for each sign-in, and the cookie holds it. The token stays only in the discovery file, as the local-server spec says. A secret in memory also ends at a restart, which is item 5 of the issue.

Alternative: the cookie holds the bearer token. This needs no store, but it writes the token to the cookie store of the browser. It also breaks the rule of the spec. Rejected.

### D2. The store of nonces and sessions is in memory, in the app

The store lives in `src/server/browser_session.ts`, because the middleware and the session routes both use it. The name keeps it apart from the chat session of `src/types/session.ts`. `buildApp` makes one store for its life. The store keeps the SHA-256 digest of each nonce and of each session secret, not the secret, in a `Map` keyed by the hex digest. A lookup by digest can show the digest through its timing, but never the secret, and a digest does not give back the secret. Thus the store needs no `timingSafeEqual` scan. The bearer token keeps its `timingSafeEqual` compare.

- A nonce lives 60 s. A browser that the command opens uses it in less than a second, and the person has time to copy a printed link.
- The store keeps at most 32 nonces that are not used, and at most 32 sessions. Before it counts the nonces, it removes each expired nonce. Past the bound, the entry of that kind that the store made first goes. The insertion order of a `Map` gives that order. The count of sign-ins comes from the person, but the bound keeps the memory fixed.
- A session has no expiry. It ends when the server stops.
- `AppOpts` holds the clock of the store, `now: () => number`, so that a test can move the time. `DEFAULT_APP_OPTS` uses `Date.now`. `guiEnabled` goes away from `AppOpts`.

### D3. The cookie attributes

`inflexa_session_<port>=<secret>; HttpOnly; SameSite=Strict; Path=/api`, with no `Max-Age`, no `Expires`, and no `Secure`. The secret is 32 random bytes in hex, the same form as the nonce and the bearer token.

- The port is in the name, because cookies ignore the port (RFC 6265, section 8.5). The production server (8431) and the dev server (8436) on `127.0.0.1` thus keep separate cookies. The port is the port of the listener, which the Host check already reads from `c.env`. A request with no listener, an `app.request()` of a test, uses the name `inflexa_session`. A test that needs a port gives it as the third argument of `app.request()`.
- `Path=/api` sends the cookie only to the API.
- `Secure` would stop the cookie on `http://127.0.0.1`. The server binds the loopback only.

### D4. One credential middleware for `/api/*`

The middleware takes the place of `bearerAuth`, and it runs after the Host and Origin check:

1. A request with the method `GET` and the path exactly `/api/v1/session` passes. Its handler checks the nonce. `c.req.path` holds no query, thus the query does not change the match. `POST /api/v1/session`, `GET /api/v1/session/`, and `GET /api/v1/session/nonce` do not pass.
2. A valid `Authorization: Bearer <token>` passes, with the credential kind `bearer`.
3. When `Sec-Fetch-Site` is absent, `same-origin`, or `none`, the middleware reads the cookie `inflexa_session_<port>`. A secret that names a session passes, with the credential kind `cookie`. For each other `Sec-Fetch-Site` value, the middleware does not read the cookie.
4. Each other request gets 401 `unauthorized`. When the middleware read a session cookie that names no session, the message tells the person to run `inflexa gui` again. Otherwise the message stays as it is today.

The middleware puts the credential kind in a context variable of `ServerEnv`. `POST /api/v1/session/nonce` gives 403 `forbidden` for the kind `cookie`. A session thus cannot make a new credential for itself, and the issue asks for the bearer token on this route.

`Sec-Fetch-Site`: `SameSite=Strict` treats `127.0.0.1:<other port>` as the same site. A page of a different local server can thus send the cookie in an `<img>` request, which carries no `Origin` header. Each current browser sends `Sec-Fetch-Site`, and that page gets `same-site`. `none` is a navigation that the person starts, for example a link that the OS opens. An absent header keeps an old browser working. The Origin check still refuses a request that carries a different origin.

Alternative: no `Sec-Fetch-Site` rule. A GET with an effect, for example the profile drive of `GET {A}/chat-context`, would then run for a page of a different local port. Rejected.

### D5. The session routes

The routes live in `src/server/routes/browser_session.ts`, mounted at `/api/v1/session`. The wire type of the nonce response lives in `src/api/browser_session.ts`.

- `POST /nonce` answers 201 `{ nonce, expiresAt }`. The nonce is 32 random bytes in hex. `expiresAt` is an ISO time.
- `GET /` reads `next` first. An absent `next` means `/gui/`. A `next` must match `^/(?![/])[!-~]*$` and hold no `\`. Otherwise the route answers 400 `validation_error` and leaves the nonce. The rule keeps out each control character and the space. A browser removes a tab or a newline from a URL, thus `/%09/evil.example` would become `//evil.example`. A CR or an LF would also make the `Location` header fail after the nonce is used.
- Then the route reads the nonce. An absent or empty nonce gets the same 401 as an unknown nonce. A valid nonce is used, the route makes the session and sets the cookie, and it answers 303 to `next` with `Cache-Control: no-store`. A 303 makes the browser do a GET of `next`.
- The route reads no cookie. Thus a browser with the old cookie of a restarted server signs in again, and the new cookie replaces the old one.

The nonce is in the query of the link, thus the history of the browser keeps it. It works one time and for 60 s, thus the history gives nothing usable.

### D6. `inflexa gui`

- An `instance` command in each build, outside the dev gate of `src/cli/index.ts`, with the policy `blocked` and a reason for the agent.
- The fetcher `src/client/browser_session.ts` sends `POST /api/v1/session/nonce` through the request helper of `src/client/api.ts`.
- The action `src/client/commands/gui.ts` reads the discovery one time. It gives the fetcher a `ClientOpts` whose `discover` gives that endpoint. Then the nonce and the `baseUrl` of the link come from one server, also when a restart occurs between two reads.
- The action prints the link with `next=/gui/`, and it says that the link works one time, within 60 s. Then it calls `openExternal`. When the open fails, it says so and exits with code 0, the same as `inflexa open`.
- The link is always printed, because `openExternal` gives `ok` when the opener starts, not when a browser shows the page. A host with an opener and no browser thus still gives the person the link.
- The command description for the reference docs: "Open the web page of the local server in the browser, signed in with a one-time link".

### D7. The placeholder page

`src/server/routes/gui.ts` gives an inline HTML string with the title "Inflexa" and the body text "Not implemented", with status 200 and `Content-Type: text/html; charset=utf-8`. `src/server/gui/poc.html` and its `file` import go away. `buildApp` always mounts `/gui` and `/gui/`. The comment on the `/gui` redirect loses its note about the token fragment.

### D8. The proof-of-concept script goes away

`scripts/poc_gui.ts` and `scripts/poc_gui.test.ts` go away. `inflexa gui` takes their place. The "The dev web page" item of `cli/CLAUDE.md` changes to name the placeholder page and `inflexa gui`.

## Risks / Trade-offs

- [The command opens `127.0.0.1`. For the cookie, `localhost:<port>` is a different host. Thus a tab there has no session.] → The command and each link of the server use `127.0.0.1`, through `serverBaseUrl`.
- [A browser restores a session cookie after its own restart.] → The session still ends at the restart of the server.
- [A different process of the same OS user can read the cookie store of the browser.] → That process can also read the discovery file. The cookie gives no more than the token.
- [The page at `/gui/` serves no function.] → The user asked for a placeholder. A later change gives the real client.
- [A browser with no `Sec-Fetch-Site` header lets a page of a different local port send the cookie.] → Accepted. Each current browser sends the header.
- [Cookies ignore the port. Thus the browser also sends the cookie to a different server on `127.0.0.1` under `/api`. That server can then use the secret from a process that is not a browser.] → Accepted, because the issue asks for the model of Jupyter, which has the same limit. The session ends when the server stops.
