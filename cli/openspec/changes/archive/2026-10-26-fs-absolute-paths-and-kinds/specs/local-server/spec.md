## RENAMED Requirements

- FROM: `### Requirement: The file system routes give metadata only`
- TO: `### Requirement: The file system routes read each path with no root limit`

## MODIFIED Requirements

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
- the records of `{A}`: the usage, the provenance, and the artifacts
- the package store: the state, the transfers, and the failed flights (retry and delete)
- the browser sign-in (`/api/v1/session`): the nonce and the sign-in link
- the file system (`/api/v1/fs`): the home folder, the list of a folder, and the bytes of a file

These routes MUST be in the file system group: each folder list, each read of the bytes of a file, and each search of the file system. A route of a different group can read the disk for its own work, for example `POST {A}/artifacts/resolve`. No route under `/api/v1/analyses/:analysisId` gives the bytes of a file.

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

#### Scenario: The server gives no file route of an analysis

- **WHEN** a client sends `GET /api/v1/analyses/a1/files?path=runs/R/A/figures/volcano.png`
- **THEN** the server answers 404 `not_found`, because no route has the path

### Requirement: The server gives the home folder and the entries of a folder

`GET /api/v1/fs/home` MUST give `{path}`, the canonical path of the home folder of the OS user that runs the server. When the server cannot resolve the home folder, it MUST give the home path as the operating system gives it.

`GET /api/v1/fs/list?path=<absolute path>` MUST give the entries of one folder in the list shape, with the key `entries`. The response MUST also give `folder: {path, readable}`. `folder.path` is the canonical path of the folder, with each symbolic link resolved. `folder.readable` is the verdict of the mode bits and the owner ids for the server user.

Each entry MUST give these fields:

- `name`, and `path`: the canonical folder path joined with the name
- `kind`: `file`, `folder`, or `symlink`, from the folder read. Each other type of entry is `file`.
- `link`: `null` for an entry that is not a link. For a link, it is `{target, broken, targetKind}`:
  - `target`: the text that the link stores, or `null` when the server cannot read it
  - `broken`: true when the read of the target fails with `ENOENT` or `ENOTDIR` (the target does not exist), or with `ELOOP` (the chain of links loops). Each other failure, for example `EACCES`, gives `false`.
  - `targetKind`: `file` or `folder`, or `null` when the server cannot read the target
- `size`: the size in bytes of a file, or `null` for a folder
- `modifiedAt`: the time of the last change, as an ISO 8601 string
- `mode`: the permission bits
- `readable` and `writable`: the verdict of the mode bits and the owner ids for the server user
- `hidden`: true when the name starts with `.`

For a link, `size`, `modifiedAt`, `mode`, `readable`, and `writable` MUST describe the target. A fact that the server cannot read MUST be `null`, and the entry MUST stay in the list. `folder.readable` MUST be `null` when the server cannot read the facts of the folder. On a platform with no POSIX user ids, `mode`, `readable`, `writable`, and `folder.readable` MUST be `null`.

The sort MUST use the kind from the folder read: each `folder` first, then each other entry. Each group MUST be in case-insensitive name order, with a fixed order for two names that differ only in case. Thus a link to a folder sorts with the files.

The list MUST hide each hidden entry. The query value `hidden=true` MUST show them. `total` MUST count the entries after this filter.

The list MUST take the paging values of the other lists. The server MUST read the facts of an entry only for the entries of the page that it gives.

The server MUST run each read of the list off the event loop. A folder on a hung mount MUST stop only its own request.

#### Scenario: The home folder

- **WHEN** a client sends `GET /api/v1/fs/home`
- **THEN** the server answers 200 with the canonical path of the home folder of the server user in `path`

#### Scenario: A home folder behind a link

- **GIVEN** a server user whose home path holds a symbolic link
- **WHEN** a client sends `GET /api/v1/fs/home`
- **THEN** `path` is the real path of the home folder, with each link resolved

#### Scenario: A folder lists folders first

- **GIVEN** a folder that holds the folder `beta`, the files `alpha.txt` and `Zeta.txt`, and the file `.env`
- **WHEN** a client lists the folder
- **THEN** the entries are `beta`, `alpha.txt`, and `Zeta.txt`, in this order, and `total` is 3
- **AND** `beta` has the kind `folder` and a `null` size, and `alpha.txt` has its size, its time, its mode, and `readable` true

#### Scenario: The hidden entries show on request

- **GIVEN** the same folder
- **WHEN** a client lists it with `hidden=true`
- **THEN** the entries include `.env` with `hidden` true, and `total` is 4

#### Scenario: A link gives its target

- **GIVEN** a folder that holds a link `data` to a folder, and a link `gone` to a path that does not exist
- **WHEN** a client lists the folder
- **THEN** `data` has the kind `symlink`, its stored target, `broken` false, and `targetKind` `folder`
- **AND** `gone` has `broken` true, `targetKind` `null`, and `null` facts
- **AND** both links sort after each `folder` entry

#### Scenario: A page of a large folder

- **GIVEN** a folder that holds 250 files
- **WHEN** a client lists it with `page=1` and `perPage=100`
- **THEN** the entries are the 101st to the 200th entry of the sort, `total` is 250, and `hasMore` is true

#### Scenario: The canonical path of a folder

- **GIVEN** a link `l` to a folder `f`
- **WHEN** a client lists the path of `l`
- **THEN** `folder.path` is the canonical path of `f`, and the path of each entry starts with it

### Requirement: The file system routes read each path with no root limit

Each route under `/api/v1/fs` MUST take each path as an absolute path. The client MUST expand `~` with the home path before it sends a path. The server MUST remove each `.` and `..` segment of a path as text, before it resolves a symbolic link. Each path that a route gives MUST be absolute, with each symbolic link of its folders resolved. The one exception is `link.target` of a list entry, because it is the text that the link stores. The server MUST change a path to a relative path only inside its own code.

The routes MUST NOT limit a path to a root. A person can browse and preview each place on the machine. The routes give what the same OS user can read with `ls -l` and `cat`. The routes MUST NOT write to the disk. The one exception is the lock file of the instance lock that the guard of `analysisId` takes. The routes use no harness runtime, thus they MUST answer while the boot of the runtime is not ready.

#### Scenario: A folder outside each analysis

- **WHEN** a client lists `/` before the runtime boot is ready
- **THEN** the server answers 200 with the entries of `/`, and no entry carries the content of a file

#### Scenario: A file outside each analysis

- **GIVEN** a file outside each workspace and outside each declared input
- **WHEN** a client reads the absolute path of the file before the runtime boot is ready
- **THEN** the server answers 200 with the bytes of the file

#### Scenario: A path with a parent segment

- **GIVEN** the file `/data/study/counts.csv`
- **WHEN** a client reads `/data/study/raw/../counts.csv`
- **THEN** the server answers 200 with the bytes of `/data/study/counts.csv`

### Requirement: The server lists the artifact ledger of an analysis

`GET {A}/artifacts` MUST give one page of the artifact ledger of the analysis in the list shape, with the key `artifacts`. Each item MUST carry these fields:

- `path`, relative to the workspace folder of the analysis. The query value `path` takes the same form.
- `absolutePath`: the canonical path of the workspace folder joined with `path`. `GET /api/v1/fs/read?path=` takes this form. It is `null` when the server cannot locate the workspace folder. When the located folder does not exist on disk, the server joins the path of the folder as it located it.
- `size`, in bytes
- `fileType`, or `null`
- `role`, `input` or `step_output`
- `runId` and `stepId`, or `null`
- `createdAt`, the time of the first registration of the path

The server MUST locate the workspace folder one time for each request, not one time for each item. The search MUST NOT make a folder, and it MUST NOT record an anchor sighting. It can repair the stored path of a moved anchor, as each workspace lookup does. A workspace folder that the server cannot locate MUST NOT fail the request. A failed read of the database MUST give 500 `internal_error`.

The query values `runId`, `stepId`, and `fileType` MUST each select the rows with that exact value. The query value `path` MUST select the row whose path is equal to the value, and case is significant. The query value `q` MUST select the rows whose path holds the text, with no regard to case. An absent or empty value MUST select each row. The filters MUST combine with AND, and `total` MUST count the rows that they select.

The extension of a path is the text after the last dot of its file name, in lower case. A file name has no extension in each of these cases:

- It has no dot.
- Its only dot is its first character.
- It ends with a dot.

The query value `extension` MUST be a list of extensions with a comma between them, for example `png,svg`. It MUST select the rows whose path has one of these extensions, with no regard to case. The server MUST remove the spaces at the start and the end of each member, and it MUST ignore an empty member. A value with no member MUST select each row.

The response MUST add `extensionCounts` to the list shape. It MUST give one entry `{ extension, count }` for each extension that a selected row has, in the order of the extension. It MUST give one last entry with `extension` `null` for the selected rows that have no extension. It MUST give no entry with a count of 0. The counts MUST sum to `total`, and they MUST NOT depend on the page.

The `sort` query value MUST select the order. `path` orders by the path, and it is the default. `recent` orders by `createdAt`, newest first, and the path breaks a tie. An absent or empty `sort` MUST select the default. A different value MUST give 400 `validation_error` with the field error under `sort`.

Each request MUST send one paged read of the harness ledger, with the limit and the offset of the page. The count of its statements MUST NOT depend on the page size. The route needs the harness runtime, thus it MUST answer 503 `unavailable` before the phase is `ready`. A failed ledger read MUST give 500 `internal_error`.

#### Scenario: The volcano figures of each run

- **GIVEN** analysis `a1` with a volcano figure in run `r1`, a volcano figure in run `r2`, and a volcano table of the type `output`
- **WHEN** a client sends `GET /api/v1/analyses/a1/artifacts?fileType=figure&q=volcano`
- **THEN** the server answers with the two figures, each with its `runId` and its `stepId`, and `total` is 2

#### Scenario: An absolute path for each item

- **GIVEN** analysis `a1` whose workspace folder has the canonical path `<W>`, and the ledger row `runs/r1/s1/figures/volcano.png`
- **WHEN** a client lists the artifacts of `a1`
- **THEN** the item has `path` `runs/r1/s1/figures/volcano.png` and `absolutePath` `<W>/runs/r1/s1/figures/volcano.png`
- **AND** `GET /api/v1/fs/read?path=<W>/runs/r1/s1/figures/volcano.png` gives the bytes of the figure

#### Scenario: A workspace folder that the server cannot locate

- **GIVEN** analysis `a1` whose anchor folder is gone, and a ledger with rows for `a1`
- **WHEN** a client lists the artifacts of `a1`
- **THEN** the server answers 200, and each item has `absolutePath` `null`

#### Scenario: The newest artifacts first

- **WHEN** a client sends `GET /api/v1/analyses/a1/artifacts?sort=recent`
- **THEN** the item with the newest `createdAt` comes first

#### Scenario: A bad sort value

- **WHEN** a client sends `GET /api/v1/analyses/a1/artifacts?sort=size`
- **THEN** the server answers 400 `validation_error` with a field error under `sort`

#### Scenario: One read for each page

- **WHEN** a client sends `GET /api/v1/analyses/a1/artifacts?page=2&perPage=50`
- **THEN** the server sends one ledger read with the limit 50 and the offset 100

#### Scenario: A link finds the run of a file

- **GIVEN** analysis `a1` with `runs/r1/s1/output/de.csv` and `runs/r2/s1/output/de.csv.bak`
- **WHEN** a client sends `GET /api/v1/analyses/a1/artifacts?path=runs/r1/s1/output/de.csv`
- **THEN** the server answers with that one item, with `runId` `r1` and `stepId` `s1`, and `total` is 1

#### Scenario: The figures of a run by their extensions

- **GIVEN** run `r1` of analysis `a1` with `runs/r1/s1/figures/a.PNG`, `runs/r1/s1/figures/b.svg`, and `runs/r1/s1/output/c.csv`
- **WHEN** a client sends `GET /api/v1/analyses/a1/artifacts?runId=r1&extension=png,%20SVG,`
- **THEN** the server sends one ledger read with the extensions `png` and `svg`
- **AND** it answers with the two figures, and `total` is 2

#### Scenario: The count of each extension of a run

- **GIVEN** run `r1` of analysis `a1` with two PNG files, one CSV file, and the file `README`
- **WHEN** a client sends `GET /api/v1/analyses/a1/artifacts?runId=r1&perPage=1`
- **THEN** the server answers with one item, and `total` is 4
- **AND** `extensionCounts` is `[{ "extension": "csv", "count": 1 }, { "extension": "png", "count": 2 }, { "extension": null, "count": 1 }]`

### Requirement: The server serves the page of a report session

The server MUST serve `GET` and `HEAD` of `/report-sessions/{analysisId}/{threadId}/<path>`. This route is outside `/api`. Thus the bearer token and the session cookie of the browser sign-in give no access to it. Only a page grant gives access. The route does the cookie swap of the managed content server:

- A request with the query value `t` MUST carry the token of a live grant for the analysis and the thread of its path. Otherwise the server MUST answer 401 `unauthorized` with the message `The link of this report page is not valid, or it expired. Open the report page again from Inflexa.` A request that passes MUST get `Set-Cookie: __ic=<token>; Path=/report-sessions/{analysisId}/{threadId}/; HttpOnly; SameSite=Lax; Max-Age=<the whole seconds that the grant still lives, rounded down>`. The cookie has no `Secure` attribute, because the server is plain HTTP on the loopback interface.
- A request with no `t` MUST need no grant when its path is `assets/<file>`, for a `file` of the page asset manifest of the harness (`PAGE_ASSETS`). These public files are the libraries and the fonts that the preview stages under `assets/deps/` beside each page. A sandboxed page fetches a font in CORS mode, and that fetch carries no cookie. Each other file under `assets/deps/` needs a grant. A public file MUST be a regular file at its own path. A symbolic link at a public path MUST get 403 `forbidden`, because its bytes are not the bytes that the preview staged.
- Each other request with no `t` MUST carry the cookie `__ic`. The cookie MUST hold the token of a live grant for the analysis and the thread of its path. Otherwise the server MUST answer 401 `unauthorized`, with the same message.

The route MUST serve a file only when its real path is inside the real path of the session folder. The session folder is `report-sessions/{threadId}/` under the workspace root. The real path of the session folder MUST be the real path of the workspace root joined with `report-sessions/{threadId}`. Otherwise the route MUST answer 403 `forbidden`, because a link moved the folder. A session folder that does not exist gets 404 `not_found`. The test resolves each symbolic link of the path, and it is boundary-safe: `/a/bc` is not inside `/a/b`. A symbolic link that leaves that folder MUST give no byte of its target. A symbolic link that replaces the last part of the path after the test MUST NOT give the bytes of its target.

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

The route MUST give these parts as the read route of the file system (`GET /api/v1/fs/read`) gives them: the content type, the `ETag`, the `If-None-Match` answer, the `Range` answer, and the streamed body. A `HEAD` request MUST get the status and the headers of the `GET`, and no body.

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

## REMOVED Requirements

### Requirement: The server gives the bytes of a file of an analysis

**Reason**: The bytes of a file move to `GET /api/v1/fs/read`, which takes an absolute path and has no root limit. The roots of the form of a path go away.

**Migration**: Send `GET /api/v1/fs/read?path=<absolute path>&analysisId=<id>`. For a workspace file, use the `absolutePath` of the artifact entry, or join the workspace folder and the relative path.

### Requirement: The file route refuses a bad request with a named error

**Reason**: The route `GET {A}/files` goes away. The read route has its own list of errors, with no root test.

**Migration**: Use the errors of "The read route refuses a bad request with a named error".

## ADDED Requirements

### Requirement: The server gives the bytes of a file at an absolute path

`GET /api/v1/fs/read?path=<absolute path>` MUST give the bytes of the file at the path. The path can name each file of the machine: a file of a workspace, a file of a declared input, or a file outside each analysis. The query value `analysisId` MUST NOT change which file the route reads.

The server MUST do these steps:

- It removes each `.` and `..` segment of the path as text.
- It resolves each symbolic link of the path, and gets the real path of the file. Thus a link gives the bytes of its target.
- It reads the bytes from the real path. A symbolic link that replaces the last part of the real path after this resolve MUST NOT give the bytes of its target.

The response MUST have these headers:

- `Content-Type` from the extension of the last part of the requested path, or `application/octet-stream` for an extension that the server does not know
- `X-Content-Type-Options: nosniff`
- `Accept-Ranges: bytes`
- `ETag`: a tag that changes when the size or the time of the last change of the file changes
- `Cache-Control: no-cache`, thus a browser asks again with the tag before it uses a copy
- `Content-Length`

A type that a browser runs as a document with script MUST also get `Content-Security-Policy: sandbox`. These types are HTML, XHTML, SVG, and XML. Thus a script in such a file cannot use the session of the browser on the origin of the server. Without this header, a script in a file can read each file on the machine through this route.

The query value `download=1` MUST add `Content-Disposition: attachment` with the last part of the requested path as the file name.

A request whose `If-None-Match` names the current tag, or `*`, MUST get 304 with no body.

A `Range` header with one range of the unit `bytes` MUST give that part of the file with 206 and `Content-Range`. The forms are `bytes=<first>-<last>`, `bytes=<first>-`, and `bytes=-<count of last bytes>`. A `<last>` past the end of the file means the end of the file.

A range that starts at or after the size of the file MUST get 416 `range_not_satisfiable` with `Content-Range: bytes */<size>`. The server MUST ignore a `Range` header that holds more than one range, a different unit, or a bad form. It then gives the full file with 200. An `If-Range` header that does not name the current tag MUST also make the server ignore the `Range` header.

A `HEAD` request MUST get the same status and headers as the `GET`, and no body.

The server MUST stream the body from the open file, and it MUST NOT read a whole file into memory. It MUST run each disk operation of the route off the event loop. A file on a hung mount MUST stop only its own request. The route MUST lift the idle timeout of its connection. This rule does not cover the guard of `analysisId`. That guard reads the database and takes the lock as the guard of each `{A}` route does.

A read that fails after the server sent the status MUST end the body with an error, and the server MUST close the file. The client then gets fewer bytes than `Content-Length`, and it cannot read the cut body as complete.

The route accepts the bearer token or the session cookie of a browser sign-in, as each route under `/api/` does.

#### Scenario: A figure of a run

- **GIVEN** a browser that signed in, and the file `runs/R/A/figures/volcano.png` in the workspace `<W>` of analysis `a1`
- **WHEN** the browser sends `GET /api/v1/fs/read?path=<W>/runs/R/A/figures/volcano.png&analysisId=a1` with its session cookie
- **THEN** the server answers 200 with the bytes of the file, `Content-Type: image/png`, `X-Content-Type-Options: nosniff`, and an `ETag`

#### Scenario: A file of a declared input

- **GIVEN** a declared input folder `/data/study`, outside the workspace, that holds `counts.csv`
- **WHEN** a client reads the absolute path `/data/study/counts.csv`
- **THEN** the server answers 200 with the bytes of the file

#### Scenario: A file outside the analysis

- **GIVEN** analysis `a1`, and the file `/tmp/notes.txt` outside its workspace and outside each of its declared inputs
- **WHEN** a client sends `GET /api/v1/fs/read?path=/tmp/notes.txt&analysisId=a1`
- **THEN** the server answers 200 with the bytes of the file

#### Scenario: A link gives the bytes of its target

- **GIVEN** a symbolic link `/data/latest.csv` to the file `/data/run7.csv`
- **WHEN** a client reads `/data/latest.csv`
- **THEN** the server answers 200 with the bytes of `/data/run7.csv` and `Content-Type: text/csv`

#### Scenario: A part of a file

- **GIVEN** a file of 1000 bytes
- **WHEN** a client reads it with `Range: bytes=0-99`
- **THEN** the server answers 206 with `Content-Range: bytes 0-99/1000` and the first 100 bytes

#### Scenario: A range past the end of the file

- **GIVEN** a file of 1000 bytes
- **WHEN** a client reads it with `Range: bytes=1000-`
- **THEN** the server answers 416 `range_not_satisfiable` with `Content-Range: bytes */1000`

#### Scenario: An unchanged file

- **GIVEN** a client that got a file and its `ETag`
- **WHEN** the client reads the same file with `If-None-Match` set to that tag, and the file did not change
- **THEN** the server answers 304 with no body

#### Scenario: A changed file

- **GIVEN** a client that got a file and its `ETag`
- **WHEN** a run writes the file again with a different size, and the client reads it with `If-None-Match` set to the old tag
- **THEN** the server answers 200 with the new bytes and a different `ETag`

#### Scenario: A download

- **WHEN** a client reads `<W>/runs/R/A/output/de.csv` with `download=1`
- **THEN** the response has `Content-Disposition: attachment` with the file name `de.csv`

#### Scenario: An HTML file runs in a sandbox

- **WHEN** a client reads an HTML file
- **THEN** the response has a `text/html` content type and `Content-Security-Policy: sandbox`

#### Scenario: An SVG file runs in a sandbox

- **WHEN** a client reads an SVG file
- **THEN** the response has an `image/svg+xml` content type and `Content-Security-Policy: sandbox`

#### Scenario: A HEAD request

- **WHEN** a client sends `HEAD` for a file
- **THEN** the server answers 200 with the headers of the `GET`, and no body

### Requirement: The read route refuses a bad request with a named error

The read route MUST give these errors before it sends a status of success:

- 400 `validation_error` when `path` is absent or empty, is not absolute, or holds a NUL byte
- 400 `validation_error` when `download` is present and is not `1`
- 404 `not_found` when the path does not exist. A symbolic link to a path that does not exist also gets 404. A loop of symbolic links, and a path with a part that is not a folder, also get 404.
- 400 `validation_error` when the path names a folder, or a different entry that is not a regular file. A platform can fail the real path of a socket. Then the socket gets 403 by the last rule.
- 403 `forbidden` when a symbolic link replaces the last part of the real path after the server resolved it
- 403 `forbidden` for each other failure of the resolve, of the open, or of the facts of the file. The message names the cause, and `details.code` holds the error code of the operating system.

The errors of the query value `analysisId` come from the guard of the file system routes.

#### Scenario: No path

- **WHEN** a client sends `GET /api/v1/fs/read` with no `path`
- **THEN** the server answers 400 `validation_error`

#### Scenario: A relative path

- **WHEN** a client sends `GET /api/v1/fs/read?path=runs/R/A/figures/volcano.png`
- **THEN** the server answers 400 `validation_error`

#### Scenario: A path that does not exist

- **WHEN** a client reads an absolute path that does not exist
- **THEN** the server answers 404 `not_found`

#### Scenario: A folder

- **WHEN** a client reads the absolute path of a folder
- **THEN** the server answers 400 `validation_error`

#### Scenario: An unreadable file

- **GIVEN** a file whose mode is 000, and a server that does not run as root
- **WHEN** a client reads the file
- **THEN** the server answers 403 `forbidden`, and `details.code` is `EACCES`

### Requirement: A file system route guards the analysis of its query value

Each route under `/api/v1/fs` MUST take the optional query value `analysisId`, and it MUST guard the analysis that the value names. An absent or empty value names no analysis. Then the route takes no instance lock.

With a value, the server MUST do the steps of the guard of each route under `/api/v1/analyses/:analysisId`, before the route reads the disk:

- It answers 404 `not_found` when no analysis has the id.
- It takes the instance lock of the analysis at the first request for that analysis, and it holds the lock until it exits.
- It answers 409 `locked` with `details.holderPid` when a different live process holds the lock.

A route that a later change adds under `/api/v1/fs` MUST get the same guard.

#### Scenario: An unknown analysis on a read

- **WHEN** a client sends `GET /api/v1/fs/read?path=<the absolute path of a file>&analysisId=nope`, and no analysis has the id `nope`
- **THEN** the server answers 404 `not_found`, and it reads no byte of the file

#### Scenario: An unknown analysis on a list

- **WHEN** a client sends `GET /api/v1/fs/list?path=/&analysisId=nope`, and no analysis has the id `nope`
- **THEN** the server answers 404 `not_found`

#### Scenario: An analysis that a different process holds

- **GIVEN** a different live process that holds the instance lock of analysis `a1`
- **WHEN** a client sends `GET /api/v1/fs/list?path=/&analysisId=a1`
- **THEN** the server answers 409 `locked` with the pid of the holder

#### Scenario: A known analysis

- **GIVEN** analysis `a1`, and no other process that holds its instance lock
- **WHEN** a client reads a file with `analysisId=a1`
- **THEN** the server answers 200, and it holds the instance lock of `a1`

#### Scenario: No analysis

- **WHEN** a client sends `GET /api/v1/fs/list?path=/` with no `analysisId`, or with an empty `analysisId`
- **THEN** the server answers 200, and it takes no instance lock

### Requirement: The file system routes take the kind of a file from its extension

The server MUST hold one map from the extension of a file name to the kind of the file. A route that gives the kind of a file MUST use this map, thus a client keeps no map of its own. The kinds and their extensions are:

- `table`: `csv`, `tsv`, `txt`, `xlsx`, `parquet`
- `figure`: `png`, `svg`, `jpg`
- `code`: `py`, `r`, `ipynb`, `toml`, `sh`
- `log`: `log`
- `data`: `json`, `h5ad`, `gz`, `bam`
- `doc`: `md`, `docx`, `pdf`

The extension of a file name is the text after its last dot. The match MUST have no regard to case. A file name has no extension in each of these cases:

- It has no dot.
- Its only dot is its first character.
- It ends with a dot.

A file name with no extension, and a file name whose extension the map does not know, MUST give `null`.

A file name whose extension is `gz` MUST take the kind of the extension before `.gz`, when the map knows that extension. Otherwise it MUST take the kind `data`.

The kind MUST come from the file name only. The folder of the file does not change the kind. Thus the kind can differ from the `fileType` of the artifact ledger, which comes from the folder.

#### Scenario: A table

- **WHEN** the server takes the kind of `counts.csv` and of `Counts.CSV`
- **THEN** each kind is `table`

#### Scenario: A compressed table

- **WHEN** the server takes the kind of `counts.csv.gz`
- **THEN** the kind is `table`

#### Scenario: A compressed file of an unknown kind

- **WHEN** the server takes the kind of `reads.gz` and of `archive.tar.gz`
- **THEN** each kind is `data`

#### Scenario: An R script

- **WHEN** the server takes the kind of `analysis.R`
- **THEN** the kind is `code`

#### Scenario: A name with no known kind

- **WHEN** the server takes the kind of `notes.xyz`, `Makefile`, `.bashrc`, and `draft.`
- **THEN** each kind is `null`
