## ADDED Requirements

### Requirement: The server keeps the page grants of the report sessions

A page grant MUST be a random token of 32 bytes in hex, for one report session: one analysis id and one thread id. A grant MUST end 900 s after its mint, which is the life of a managed content token, or earlier when the store drops it at the limit. The server MUST keep the grants in memory only, thus a restart ends each grant. It MUST keep the SHA-256 digest of each token, and never the token. It MUST find a presented token by its digest.

The server MUST keep at most 256 grants. Before a mint counts the grants, the server MUST remove each expired grant. When a new grant goes past the limit, the oldest grant MUST go.

One store MUST serve each mint of the server process: the mint of the report preview and the mint of the access route. Thus a URL from either mint opens the page through the page route.

#### Scenario: A grant names one session

- **GIVEN** a grant for analysis `a1` and thread `t1`
- **WHEN** the page route checks the token for analysis `a1` and thread `t2`
- **THEN** the check fails

#### Scenario: A grant expires

- **GIVEN** a grant that the server made 901 s ago
- **WHEN** the page route checks its token
- **THEN** the check fails

#### Scenario: The store keeps no token

- **WHEN** the server mints a grant
- **THEN** the store holds the digest of the token, and no field of the store holds the token

#### Scenario: The oldest grant goes at the limit

- **GIVEN** 256 live grants
- **WHEN** the server mints one more grant
- **THEN** the first grant of the 256 no longer passes the check, and the new grant passes

### Requirement: The server serves the page of a report session

The server MUST serve `GET` and `HEAD` of `/report-sessions/{analysisId}/{threadId}/<path>`. This route is outside `/api`. Thus the bearer token and the session cookie of the browser sign-in give no access to it. Only a page grant gives access. The route does the cookie swap of the managed content server:

- A request with the query value `t` MUST carry the token of a live grant for the analysis and the thread of its path. Otherwise the server MUST answer 401 `unauthorized` with the message `The link of this report page is not valid, or it expired. Open the report page again from Inflexa.` A request that passes MUST get `Set-Cookie: __ic=<token>; Path=/report-sessions/{analysisId}/{threadId}/; HttpOnly; SameSite=Lax; Max-Age=<the whole seconds that the grant still lives, rounded down>`. The cookie has no `Secure` attribute, because the server is plain HTTP on the loopback interface.
- A request with no `t` MUST need no grant when its path is `assets/<file>`, for a `file` of the page asset manifest of the harness (`PAGE_ASSETS`). These public files are the libraries and the fonts that the preview stages under `assets/deps/` beside each page. A sandboxed page fetches a font in CORS mode, and that fetch carries no cookie. Each other file under `assets/deps/` needs a grant. A public file MUST be a regular file at its own path. A symbolic link at a public path MUST get 403 `forbidden`, because its bytes are not the bytes that the preview staged.
- Each other request with no `t` MUST carry the cookie `__ic`. The cookie MUST hold the token of a live grant for the analysis and the thread of its path. Otherwise the server MUST answer 401 `unauthorized`, with the same message.

The route MUST serve a file only when its real path is inside the real path of the session folder. The session folder is `report-sessions/{threadId}/` under the workspace root. The real path of the session folder MUST be the real path of the workspace root joined with `report-sessions/{threadId}`. Otherwise the route MUST answer 403 `forbidden`, because a link moved the folder. A session folder that does not exist gets 404 `not_found`. The test is the real-path test of the file route of an analysis. A symbolic link that leaves that folder MUST give no byte of its target. A symbolic link that replaces the last part of the path after the test MUST NOT give the bytes of its target.

The route MUST run its checks in this order: the form of the ids and of the path, the proof, then the file. Thus a request with no proof never learns whether a guarded file exists.

The route MUST answer 404 `not_found` in these cases:

- The path names no file, a folder, or an entry that is not a regular file.
- A segment of the path starts with `.`. The managed content server hides each such file.
- The analysis id or the thread id holds a `/`, a `\`, or a NUL byte, or it is `.` or `..`.
- The server cannot locate the workspace root of the analysis.

A real path outside the session folder MUST get 403 `forbidden`.

Each response of the route MUST have these headers. This includes an error response and a 304 response:

- `Content-Security-Policy: sandbox allow-scripts allow-downloads`. The page then has an opaque origin, thus a script of the page cannot use the origin of the API. `allow-downloads` keeps the table and chart downloads of the page.
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`. The URL of the page carries the token, and a link of the page to a different site must not send it.
- `Cache-Control: no-store`

A response for a public file MUST also have `Access-Control-Allow-Origin: *`. Without it, the browser refuses a font that a sandboxed page fetches.

The route MUST give these parts as the file route of an analysis gives them: the content type, the `ETag`, the `If-None-Match` answer, the `Range` answer, and the streamed body. A `HEAD` request MUST get the status and the headers of the `GET`, and no body.

#### Scenario: The entry request sets the cookie

- **GIVEN** a live grant for analysis `a1` and thread `t1`, and the page of that session on disk
- **WHEN** a browser requests `/report-sessions/a1/t1/index.html?t=<token>`
- **THEN** the server answers 200 with the page, and it sets the cookie `__ic` with `Path=/report-sessions/a1/t1/`, `HttpOnly`, and `SameSite=Lax`

#### Scenario: An asset loads with the cookie

- **GIVEN** a browser that holds the cookie of a live grant for analysis `a1` and thread `t1`
- **WHEN** the browser requests `/report-sessions/a1/t1/assets/fig.png` with the cookie and no `t`
- **THEN** the server answers 200 with the bytes of the figure

#### Scenario: An asset with no cookie

- **WHEN** a browser requests `/report-sessions/a1/t1/assets/fig.png` with no `t` and no cookie
- **THEN** the server answers 401 `unauthorized`

#### Scenario: A token of a different session

- **GIVEN** a live grant for analysis `a1` and thread `t1`
- **WHEN** a browser requests `/report-sessions/a1/t2/index.html` with the token of that grant in `t`
- **THEN** the server answers 401 `unauthorized`, and it sets no cookie

#### Scenario: An expired token

- **GIVEN** a grant that expired
- **WHEN** a browser requests the page with its token in `t`
- **THEN** the server answers 401 `unauthorized`, and it sets no cookie

#### Scenario: A font needs no token

- **WHEN** a browser requests `/report-sessions/a1/t1/assets/deps/font.woff2` with `Origin: null`, no `t`, and no cookie
- **THEN** the server answers 200 with the font and `Access-Control-Allow-Origin: *`

#### Scenario: An unlisted file under deps needs a grant

- **WHEN** a browser requests `/report-sessions/a1/t1/assets/deps/notes.csv`, a name that the manifest does not carry, with no `t` and no cookie
- **THEN** the server answers 401 `unauthorized`

#### Scenario: A link at a public path

- **GIVEN** a symbolic link at `report-sessions/t1/assets/<file of the manifest>` to `report-sessions/t1/assets/notes.csv`
- **WHEN** a browser requests that public path with no `t` and no cookie
- **THEN** the server answers 403 `forbidden`, and it gives no byte of `notes.csv`

#### Scenario: A session folder that is a link

- **GIVEN** a folder `report-sessions/t1` that is a symbolic link to a different folder
- **WHEN** a browser with a live cookie for the session requests a file of it
- **THEN** the server answers 403 `forbidden`, and it gives no byte

#### Scenario: A 304 keeps the sandbox

- **GIVEN** a browser with a live cookie that sends `If-None-Match` with the current tag of the page
- **WHEN** the route answers 304
- **THEN** the response has the `Content-Security-Policy`, `Referrer-Policy`, and `Cache-Control` headers of the route

#### Scenario: A link that leaves the session folder

- **GIVEN** a symbolic link `report-sessions/t1/assets/leak.txt` to a file outside that folder
- **WHEN** a browser with a live cookie for the session requests it
- **THEN** the server answers 403 `forbidden`, and it gives no byte of the target

#### Scenario: A link to a different session

- **GIVEN** a symbolic link in `report-sessions/t1/assets/` to a file of `report-sessions/t2/`
- **WHEN** a browser with a live cookie for thread `t1` requests it
- **THEN** the server answers 403 `forbidden`

#### Scenario: A hidden file

- **WHEN** a browser with a live cookie requests `/report-sessions/a1/t1/.state`
- **THEN** the server answers 404 `not_found`

#### Scenario: The page runs in a sandbox

- **WHEN** the route serves the page of a session
- **THEN** the response has `Content-Security-Policy: sandbox allow-scripts allow-downloads`, `Referrer-Policy: no-referrer`, and `Cache-Control: no-store`

#### Scenario: The API credentials give no access

- **GIVEN** a browser that signed in through `inflexa gui`, and a client with the bearer token
- **WHEN** each requests `/report-sessions/a1/t1/index.html` with no `t` and no `__ic` cookie
- **THEN** the server answers 401 `unauthorized` to each

### Requirement: The server mints the access of a report-session page

`POST {A}/report-sessions/{threadId}/access` MUST mint a new page grant for the analysis and the thread. It MUST answer 200 with `{url, expiresAt}`. `url` MUST be `{base}/report-sessions/{analysisId}/{threadId}/index.html?t={token}`, through the formula of the harness contract. The base is `http://127.0.0.1:<port>`, with the port that the server bound. `expiresAt` MUST be the ISO 8601 time at which the grant ends. The path tail is the tail of the managed mint route.

The route accepts the bearer token or the session cookie of a browser sign-in, as each route under `/api/` does. The guard of an analysis route runs first. The route needs no harness runtime.

The route MUST give these errors, and it MUST mint no grant for them:

- 400 `validation_error` when the thread id holds a `/`, a `\`, or a NUL byte, or it is `.` or `..`
- 404 `not_found` when `report-sessions/{threadId}/index.html` is not a file under the workspace root, because no preview rendered a page for that session
- 409 `conflict` with the message of the workspace error, when the server cannot locate the workspace root

#### Scenario: A client gets the URL of a page

- **GIVEN** a report session `t1` of analysis `a1` whose preview rendered a page
- **WHEN** a client sends `POST /api/v1/analyses/a1/report-sessions/t1/access` with the bearer token
- **THEN** the server answers 200 with a URL under `/report-sessions/a1/t1/index.html?t=` and its expiry

#### Scenario: The URL opens the page

- **GIVEN** a URL that the access route gave
- **WHEN** a browser requests that URL
- **THEN** the page route answers 200 with the page, and it sets the cookie `__ic`

#### Scenario: A session with no page

- **WHEN** a client asks for the access of a session whose folder holds no `index.html`
- **THEN** the server answers 404 `not_found`, and it mints no grant

#### Scenario: A request with no credential

- **WHEN** a client sends the access request with no bearer token and no session cookie
- **THEN** the server answers 401 `unauthorized`

## MODIFIED Requirements

### Requirement: The server answers only a request to its own address

The `Host` header of each request MUST be `127.0.0.1:<port>` or `localhost:<port>`, where the port is the port that the server bound. Otherwise the server MUST answer 403 `forbidden`. An `Origin` header MUST be `http://` with one of the two, or absent. The check MUST run on each path, before the credential check. A web page whose host name points at 127.0.0.1 still sends its own host name, and a page cannot change the two headers. Thus the check stops a DNS rebind.

A `GET` or a `HEAD` request to a path under `/report-sessions/` MUST also pass with the `Origin` header `null`. The page of a report session has an opaque origin, because it runs in a sandbox, and it sends `Origin: null` when it fetches a font. The `Host` check still runs on that path. Each request to a path under `/api/` with `Origin: null` MUST get 403 `forbidden`.

A request that no socket carried, an `app.request()` call of a test, MUST pass the check.

#### Scenario: A rebound host name

- **WHEN** a request to the server sends the `Host` header `evil.example:8436`
- **THEN** the server answers 403 `forbidden`, and no route runs

#### Scenario: A page of a different origin

- **WHEN** a request sends the correct `Host` header and the `Origin` header `http://evil.example`
- **THEN** the server answers 403 `forbidden`

#### Scenario: A sandboxed report page fetches a font

- **WHEN** a `GET` request to `/report-sessions/a1/t1/assets/deps/font.woff2` sends the correct `Host` header and `Origin: null`
- **THEN** the check passes, and the page route answers

#### Scenario: A sandboxed page calls the API

- **WHEN** a request to `/api/v1/projects` sends the correct `Host` header and `Origin: null`
- **THEN** the server answers 403 `forbidden`

### Requirement: The routes group by domain and keep the Cortex path tail

The routes MUST be under `/api/v1`, in these groups:

- the server: its state, a new boot, the activity, and the stop
- the machine: the account, the agents and their models, the models of the connection, the settings, and the embedding models
- the desktop of the machine (`/api/v1/sandbox` and `/api/v1/open-directory`): the sandbox readiness of the machine, and the folder open
- the projects, the anchors (repair, relocate, prune), and the analyses (resolve, list, make)
- the attention read (`/api/v1/attention`): the work that waits for the person, over each analysis
- one analysis `{A}` (`/api/v1/analyses/:analysisId`): the analysis itself, its output folder, and its inputs
- the conversation of `{A}`: the threads, the chat, the turns, the asks, and the access of a report-session page
- the runs of `{A}`: the runs, one run, its stream, its synthesis, its cancel, its seen mark, one plan, and its approval
- the profile of `{A}`: the chat context, the data profile, the sandbox readiness, and the farm heal and link
- the records of `{A}`: the usage, the provenance, the artifacts, and the bytes of a file
- the package store: the state, the transfers, and the failed flights (retry and delete)
- the browser sign-in (`/api/v1/session`): the nonce and the sign-in link
- the file system (`/api/v1/fs`): the home folder and the list of a folder

The page of a report session (`/report-sessions/...`) is the one route of data outside `/api/v1`. A page grant guards it, and no API credential does.

The `store` and `sandbox` commands run in their own process, with no server. Thus the server MUST NOT give a route for these operations:

- the inventory of the store
- an add
- a cancel of the catalog transfer
- a reclamation
- the report of `inflexa sandbox status`: the images with their digests, the transfers, and the store summary

The sandbox readiness of the machine (`GET /api/v1/sandbox`) is not that report. A page reads it, and the `sandbox status` command does not use it.

A route that does the same work as a Cortex route MUST keep the path tail of Cortex without the organization segment. Path segments MUST be kebab-case, a run list MUST be `runs`, and one run MUST be `run/:runId`. JSON fields MUST be camelCase, and timestamps MUST be ISO 8601 strings. The server MUST map each harness row to its wire type, and a client MUST never get a harness row type.

A client can call a route with no request body. If such a route can work for longer than 10 s before its response, it MUST lift the idle timeout of the connection for that request. `Bun.serve` closes a silent connection at 10 s only when its request has no body.

#### Scenario: A thread route keeps the Cortex tail

- **WHEN** a client lists the threads of analysis `a1`
- **THEN** the path is `/api/v1/analyses/a1/threads`, the Cortex tail with no organization segment

#### Scenario: The access route keeps the tail of the managed mint

- **WHEN** a client asks for the access of the page of report session `t1` of analysis `a1`
- **THEN** the path is `/api/v1/analyses/a1/report-sessions/t1/access`

#### Scenario: The server gives no reclaim route

- **WHEN** a client sends `POST /api/v1/store/reclaim`
- **THEN** the server answers 404 `not_found`
