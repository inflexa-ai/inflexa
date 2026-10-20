# Serve the report-session pages from the local server

## Why

A browser client cannot show the page of a report session, because `preview_report` gives a path on the disk alone. The harness declares the hosted view of a page as the `MakeSessionPagePublisher` seam. The CLI binds nothing, thus the local default refuses each mint (inflexa-ai/inflexa#641). The page must run in a sandbox, and the browser does not send the session cookie of the API from a sandboxed page. Thus the file route of `{A}/files` cannot serve the page assets.

## What Changes

- The server keeps a store of page grants in memory. A grant is a random token for one report session `report-sessions/{analysisId}/{threadId}`, with a life of 900 s.
- The composition root of the server binds `makeSessionPagePublisher`. Each preview then mints one grant, and the `rendered` arm of `preview_report` carries the URL of the page beside the path. The URL is the harness formula `{base}/report-sessions/{analysisId}/{threadId}/index.html?t={token}`, with the base URL of the local server.
- A new route serves `GET` and `HEAD` of `/report-sessions/{analysisId}/{threadId}/*`, outside `/api`. It does the same cookie swap as the managed content server:
  - A request with `?t=` must carry a live grant of the session. The route then sets the cookie `__ic` with that token, with `Path=/report-sessions/{analysisId}/{threadId}/`, `HttpOnly`, and `SameSite=Lax`.
  - A request with no `?t=` must carry that cookie.
  - The files of the harness page asset manifest under `assets/deps/` (the shipped libraries and fonts) need no token. A font fetch from a sandboxed page sends no cookie.
- The route serves only the files whose real path is inside `report-sessions/{threadId}/` of the workspace. It reuses the real-path test and the streamed body of the `{A}/files` route.
- Each response of the route carries `Content-Security-Policy: sandbox allow-scripts allow-downloads`. Thus a page script cannot use the origin of the API. `allow-downloads` keeps the table and chart downloads of the page.
- The Host and Origin check lets `Origin: null` through on the page route, because a sandboxed page sends that origin on a font fetch.
- A new API route `POST /api/v1/analyses/{A}/report-sessions/{threadId}/access` mints a fresh grant and gives the URL of the page. It keeps the path tail of the managed mint route.
- A new palette command "Open report page" opens the URL of the page of the open report session in the default browser.
- The eyes keep their `file://` URL, and the CLI does not bind `ResolvePageUrl`. The eyes container already holds the workspace root at the host path. Also, the Host check refuses a request from the container.

No harness change. The harness contract owns the entry URL alone, and the serving host decides how a later request proves the token.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-server`: the page route, the access route, the Origin exception of the page route, and the route groups.
- `harness-runtime`: the binding of the session-page publisher, and the local preview that carries a URL.
- `report-session-navigation`: the palette command that opens the page of the open report session.

## Impact

- `src/server/serve.ts`, `src/server/boot.ts`, `src/server/app.ts`: the grant store, the boot option, the page route, and the Origin exception.
- `src/server/routes/files.ts`: the open, the real-path test, and the streamed body become shared with the page route.
- A new route file for the page route and the access route, and a new store file beside `src/server/browser_session.ts`.
- `src/modules/harness/runtime.ts`: the publisher option of `bootHarnessRuntime`.
- `src/api/`, `src/client/`: the wire type and the fetcher of the access route.
- `src/tui/commands.tsx`: the palette command.

No new dependency. No new CLI command, thus no agent policy changes.
