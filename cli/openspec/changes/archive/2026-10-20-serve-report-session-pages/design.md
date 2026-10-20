# Design

## Context

Refer to proposal.md for the reason of the change. These facts shape the approach:

- The harness mints after each render through `MakeSessionPagePublisher` (`harness/src/tools/report-session/session-page-publisher.ts:65`). It spells the URL through `buildReportSessionUrl` (`harness/src/contracts/content-url.ts:54`): `{base}/report-sessions/{analysisId}/{threadId}/index.html?t={token}`. The harness contract owns this entry URL alone.
- The managed content server (the `content-server` chart of `platform-charts`, `templates/configmap.yaml`) does a cookie swap. A request with `?t=` sets `__ic=<token>; Path=/{res}/; HttpOnly; SameSite=Lax; Max-Age=900`. A request with no `t` reads the token from that cookie. The user decided that the CLI server does the same.
- The page loads its libraries, its table data, and its figures through `<script src>` and `<img>` (`harness/src/report-render/page.ts:41-59`, `table-data.ts:189`). These are no-cors requests, and they carry cookies. The page loads its fonts through `@font-face` (`harness/src/report-render/design.ts:27-61`). A font fetch is a CORS request with the credentials mode `same-origin`.
- Under `Content-Security-Policy: sandbox`, the page has an opaque origin. Thus each font fetch is cross-origin: it carries no cookie, and it sends `Origin: null`. The fonts and the libraries stage under `assets/deps/` (`harness/src/report-render/assets.ts`).
- `hostOriginGuard` (`src/server/app.ts:96-116`) refuses each `Origin` that is not the server address. `credentialAuth` guards `/api/*` only (`src/server/app.ts:54`).
- The file route of an analysis (`src/server/routes/files.ts`) holds the real-path test, the open with `O_NOFOLLOW`, the ETag, the range, and the streamed body.
- The runtime boots in the server through `bootServerRuntime` (`src/server/boot.ts:193`). The dev `run --plan` boots its own runtime with no server (`src/modules/harness/dev/run.ts:421`).
- The eyes run one container with the workspace root at the host path, and they navigate `file://` (`src/modules/harness/eyes.ts:1-9`).

## Goals / Non-Goals

**Goals:**

- A browser shows the page of a report session from the local server, with its figures, tables, scripts, and fonts.
- No API credential reaches the page, and no page script can use the API.

**Non-Goals:**

- A change of the harness. The serving host decides how a later request proves the token.
- A token in the path, or any URL shape other than the harness formula.
- A served URL for the eyes.
- A new visual block in the TUI.
- The fetch directives of the managed CSP tier (`default-src`, `connect-src`, and the others). The issue names the sandbox alone.

## Decisions

### D1. The cookie swap of the managed content server

The entry request carries the token in `t`. The route checks it against the grant store, then it sets `__ic` with the same token, scoped to `Path=/report-sessions/{analysisId}/{threadId}/`. Each later request of the page reads the cookie. This is the decision of the user. The harness contract owns the entry URL alone, thus the asset proof is a choice of the serving host.

The attributes copy the managed server: `HttpOnly`, `SameSite=Lax`, and `Max-Age`. `Max-Age` is the seconds that the grant still lives, thus the cookie never outlives its grant. `Secure` is absent, as the managed server omits it on plain HTTP. The name is `__ic`, as the user named it. The path holds the analysis id and the thread id, thus a cookie of one session never reaches a different session.

The alternative was a token in the path after a redirect. The user refused it, because it puts a URL shape into the local host that the managed host does not have.

### D2. The manifest files are public, with `Access-Control-Allow-Origin: *`

A font fetch from the sandboxed page carries no cookie. Thus a cookie gate on a font always fails. The page asset manifest of the harness (`PAGE_ASSETS`, a barrel export that `src/modules/harness/runtime.ts:16` already imports) names the libraries and the fonts that the preview stages under `assets/deps/`. Each page holds the same bytes, and no user data is in them. The route serves exactly the files `assets/<file>` of the manifest with no token, and with `Access-Control-Allow-Origin: *`, because the browser refuses a cross-origin font with no CORS header.

The public set is the manifest and not the whole folder. The sweep of the preview keeps `assets/deps/` whole (`harness/src/tools/report-session/preview-report.ts:417`), and the conversation agent can write a file anywhere in the analysis tree. Thus a file that a different writer puts under `assets/deps/` needs a grant. A request with `t` for a public file still runs the token check, thus the entry rule stays one rule.

A public file must also be a regular file at its own path. The preview copies each manifest file, thus a link at a public path is never its own output, and the route refuses it with 403. Thus a link cannot publish a different file of the session under a manifest name.

### D3. The grant store

The store lives beside `src/server/browser_session.ts` and copies its shape: a map from the SHA-256 digest of each token to its analysis id, its thread id, and its expiry. A token is 32 random bytes in hex. A grant lives 900 s, the TTL of a managed content token. The store sweeps the expired grants before each mint, and it drops the oldest grant above 256 grants.

256 grants is the bound on the memory of the store. A grant comes from a preview or from an open of the page, and it lives 15 minutes. One person makes far fewer grants than 256 in that time. An entry is a digest and three short strings.

The store holds no base URL, because `startTestServer` learns its port after `buildApp` (`src/test_support/server.ts:79`). The publisher gets `serverBaseUrl(env.serverPort)` (`src/client/api.ts:51`) from `runServe`. The access route reads the port of the listener that carried the request (`listenerPort`, `src/server/http.ts:25`), as the cookie name of the sign-in does. A request with no socket, a test call of `app.request()`, uses `env.serverPort`.

The alternative was an HS256 token, as the managed server uses. One process mints and checks the token, thus a signature adds no proof. Also, a restart then cannot end a token.

### D4. One store, made in `runServe`, given to the app and to the boot

`runServe` makes the store one time. It gives the store to `buildApp` through `AppDeps`. It gives the publisher factory over the store to the boot: `bootServerRuntime` passes `makeSessionPagePublisher` to `bootHarnessRuntime`, which puts it on `core`.

The factory and the store stay in `src/server/`. A module must not import `src/server/`. Thus the runtime gets the factory as a value, typed with the harness `MakeSessionPagePublisher`. The `run --plan` path passes no factory, thus its runtime binds no publisher. A module-level singleton store would put a publisher into that runtime too. Its URLs would then name a page that no route of that process serves.

The factory ignores `auth`. One server serves one OS user, and the page grant is the whole authorization of the page route.

### D5. The page route

A new route file holds the page route and the access route. `buildApp` mounts the page route at `/report-sessions` before `notFound`. It mounts the access route under `/api/v1/analyses/:analysisId/report-sessions` after the analysis guard.

The page route does these steps in order:

1. It refuses a bad analysis id or thread id, and each path segment that starts with `.`, with 404.
2. It decides the proof: the query `t`, else a public manifest file, else the cookie `__ic`. A failed proof gets 401.
3. It locates the workspace root with `workspaceReadRoot`. A failure gets 404. The route is outside the analysis guard, and a request for a public file has no grant. Thus the route does not tell an unknown analysis from a lost folder, and a request with no grant learns nothing about the ids. The access route is an API route behind the analysis guard, thus it keeps the 409 of the file route.
4. It requires that the real path of the session folder is the real path of the workspace root joined with `report-sessions/{threadId}`. A folder that a link moved gets 403. Then it runs the real-path test of the target against that folder as the one root.
5. It opens the real path and streams the body through the code of the file route.
6. On the entry request, it sets the cookie on the response of the file.

The headers of each response, an error response and a 304 response too: the CSP `sandbox allow-scripts allow-downloads`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `Cache-Control: no-store`. `allow-downloads` keeps the `<a download>` controls of the page (`harness/src/report-render/views/values.tsx:272`, `views/chart-view.tsx:144`). A sandbox without it blocks each download.

`Cross-Origin-Resource-Policy: same-origin` of the managed server is absent. The request origin of a sandboxed page is opaque, thus that header would block each image and each script of the page.

### D6. One implementation of the file response

The page route uses the code of `src/server/routes/files.ts` for these parts: the real-path verdict, the `O_NOFOLLOW` open, the stat, the ETag, the range, and the streamed body. That code becomes exported from `files.ts`, with a parameter for the headers that differ: the CSP, the cache policy, and the CORS header. The file route keeps its own headers and its behavior. No second copy of the open or of the stream exists.

### D7. The Origin exception

`hostOriginGuard` lets `Origin: null` through only for a `GET` or a `HEAD` to a path under `/report-sessions/`. The `Host` check still runs there. A page of a different site gets no file from this exception. Each file outside the manifest needs a grant. Also, a CORS read of a file needs an `Access-Control-Allow-Origin` header, and the route gives that header only for the public files. `/api/*` keeps the full check.

### D8. The access route

`POST /api/v1/analyses/:analysisId/report-sessions/:threadId/access` keeps the path tail of the managed mint route (`nexus`, `handler/v1/analysis/routes.go:32`). The answer is `{url, expiresAt}`. The server builds `url` with `buildReportSessionUrl`, thus the formula stays in the harness contract and a client builds no URL. The wire type lives in `src/api/`, and a fetcher in `src/client/`.

The route mints only when `report-sessions/{threadId}/index.html` is a file. Thus the TUI gives a notice in place of a browser tab that shows a 404 body. The route reads no thread row, thus it needs no runtime. A page file exists only where a report preview rendered it.

### D9. The TUI opens the page through a palette command

The command `session.open-report-page` lives in `src/tui/commands.tsx`, in the Session category. It reads the open thread through `readOpenThread`, as the report-session flows do (`src/tui/commands.tsx:1237`). It calls the access route, and it opens the URL with `openExternal` (`src/lib/open_external.ts`). The notices copy the wording pattern of `src/tui/hooks/artifacts.ts`.

A palette command adds no visual block, thus the design gallery needs no addition. The alternative was an openable card on the `data-report-rendered` part. That is a new state of the transcript, and the gallery does not show it.

### D10. No `ResolvePageUrl` binding

The eyes already open the page through `file://`, with the root mounted at the host path. A served URL would make the container reach the loopback interface of the host, and the `Host` check refuses `host.containers.internal`. Thus a binding adds a failure path and no gain.

## Risks / Trade-offs

- [The site of a sandboxed page] RFC 6265bis computes the site of a sandboxed document from its URL. Thus a `SameSite=Lax` cookie flows on each asset request. A browser that treats the page as cross-site sends no cookie, and each guarded asset gets 401. → The managed server takes the same risk, and the user chose parity with it.
- [The token in the URL] The entry URL carries the token, in the address bar and in the history. → The grant lives 900 s, `Referrer-Policy: no-referrer` keeps it off each outbound link, and the server keeps only its digest.
- [A restart] A restart ends each grant, and an open page loses its later assets. → The person opens the page again through the palette, which mints a new grant.
- [The public `assets/deps/`] A local process that knows an analysis id and a thread id can read the shipped libraries and fonts. → These are public bytes of the harness package.
- [A page of a different local port] `SameSite=Lax` treats each port of 127.0.0.1 as one site. Thus a page of a different local server can include a guarded data script of an open page, and the cookie rides that request. A `Sec-Fetch-Site` rule cannot stop it, because the sandboxed page itself sends `cross-site`. → The page needs both ids, which are random, and the grant lives 900 s. The managed server has the same exposure inside its registrable domain.
- [A file written at a manifest path] The conversation agent can write a regular file at a manifest path, and that file is public until the next preview copies the shipped file over it. → A reader needs both ids, which are random. The user accepted public manifest files, and the bytes of a public path never come from a link.
- [One cookie name for each port] Cookies ignore the port, thus the dev server and the production server share the name `__ic`. → The path holds the analysis id and the thread id. A clash needs the same ids on both servers, and the next open sets a new cookie.
