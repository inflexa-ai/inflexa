## MODIFIED Requirements

### Requirement: The API has one error body and one list shape

Each error response MUST have the body `{error, message, details?}`, and each code MUST have one status:

| Code | Status |
|-|-|
| `invalid_json`, `validation_error` | 400 |
| `unauthorized` | 401 |
| `forbidden` | 403 |
| `not_found` | 404 |
| `conflict`, `busy`, `locked` | 409 |
| `range_not_satisfiable` | 416 |
| `internal_error` | 500 |
| `unavailable`, `draining` | 503 |

A `validation_error` MUST carry the zod flatten output in `details`. A 500 MUST carry a generic message, and the cause MUST go only to the log. An unknown path MUST get 404 `not_found`.

Each list MUST take the query values `page` (zero-based, default 0) and `perPage` (default 100, cap 200). A bad value MUST fall back to the default, and it MUST NOT give a 400. The response MUST be `{<resource>: T[], total, page, perPage, hasMore}`, where the key names the resource. A list MUST add a different field to this shape only when its own requirement names that field, for example `folder` of the folder list.

#### Scenario: A body that is not JSON

- **WHEN** a client sends `POST /api/v1/projects` with a body that is not JSON
- **THEN** the server answers 400 with the error `invalid_json`

#### Scenario: A bad page value

- **WHEN** a client sends `GET /api/v1/projects?perPage=abc`
- **THEN** the server answers with `perPage` 100

### Requirement: The routes group by domain and keep the Cortex path tail

The routes MUST be under `/api/v1`, in these groups:

- the server: its state, a new boot, the activity, and the stop
- the machine: the account, the agents and their models, the models of the connection, the settings, and the embedding models
- the projects, the anchors (repair, relocate, prune), and the analyses (resolve, list, make)
- one analysis `{A}` (`/api/v1/analyses/:analysisId`): the analysis itself, its output folder, and its inputs
- the conversation of `{A}`: the threads, the chat, the turns, and the asks
- the runs of `{A}`: the runs, one run, its stream, and its cancel
- the profile of `{A}`: the chat context, the data profile, the sandbox readiness, and the farm heal and link
- the records of `{A}`: the usage, the provenance, the artifacts, and the bytes of a file
- the package store: the state, the transfers, and the failed flights (retry and delete)
- the browser sign-in (`/api/v1/session`): the nonce and the sign-in link
- the file system (`/api/v1/fs`): the home folder and the list of a folder

The `store` commands run in their own process, with no server. Thus the server MUST NOT give a route for these operations:

- the inventory of the store
- an add
- a cancel of the catalog transfer
- a reclamation
- the sandbox status

A route that does the same work as a Cortex route MUST keep the path tail of Cortex without the organization segment. Path segments MUST be kebab-case, a run list MUST be `runs`, and one run MUST be `run/:runId`. JSON fields MUST be camelCase, and timestamps MUST be ISO 8601 strings. The server MUST map each harness row to its wire type, and a client MUST never get a harness row type.

A route that can work for longer than 10 s before its response, and that a client calls with no request body, MUST lift the idle timeout of the connection for that request. `Bun.serve` closes a silent connection at 10 s only when its request has no body.

#### Scenario: A thread route keeps the Cortex tail

- **WHEN** a client lists the threads of analysis `a1`
- **THEN** the path is `/api/v1/analyses/a1/threads`, the Cortex tail with no organization segment

#### Scenario: The server gives no reclaim route

- **WHEN** a client sends `POST /api/v1/store/reclaim`
- **THEN** the server answers 404 `not_found`

## ADDED Requirements

### Requirement: The server gives the bytes of a file of an analysis

`GET {A}/files?path=<path>` MUST give the bytes of one file from the readable roots of the analysis. The form of the path selects the roots:

- A relative path resolves against the workspace root of the analysis. Its root is the workspace root.
- An absolute path stays as it is. Its roots are the declared inputs of the analysis that resolve. The user gave consent for an input when the user declared it.

The search for the roots MUST NOT make a folder, and it MUST NOT record an anchor sighting. It can repair the stored path of a moved anchor, as each workspace lookup does.

The server MUST then do these steps:

- It resolves each symbolic link of the path, and gets the real path of the file.
- The real path MUST be inside the real path of a root of the form of the path. A real path equal to a root is inside it, thus a declared input that is one file passes. The test is boundary-safe: `/a/bc` is not inside `/a/b`.
- An absolute path inside the workspace gets 403, unless a declared input holds it. The client uses the relative form of that path.
- The server reads the bytes from the real path that passed the test. A symbolic link that replaces the last part of the path after the test MUST NOT give the bytes of its target.

The response MUST have these headers:

- `Content-Type` from the extension of the last part of the requested path, or `application/octet-stream` for an extension that the server does not know
- `X-Content-Type-Options: nosniff`
- `Accept-Ranges: bytes`
- `ETag`: a tag that changes when the size or the time of the last change of the file changes
- `Cache-Control: no-cache`, thus a browser asks again with the tag before it uses a copy
- `Content-Length`

A type that a browser runs as a document with script MUST also get `Content-Security-Policy: sandbox`. These types are HTML, XHTML, SVG, and XML. Thus a script in such a file cannot use the session of the browser on the origin of the server.

The query value `download=1` MUST add `Content-Disposition: attachment` with the last part of the requested path as the file name.

A request whose `If-None-Match` names the current tag, or `*`, MUST get 304 with no body.

A `Range` header with one range of the unit `bytes` MUST give that part of the file with 206 and `Content-Range`. The forms are `bytes=<first>-<last>`, `bytes=<first>-`, and `bytes=-<count of last bytes>`. A `<last>` past the end of the file means the end of the file.

A range that starts at or after the size of the file MUST get 416 `range_not_satisfiable` with `Content-Range: bytes */<size>`. The server MUST ignore a `Range` header that holds more than one range, a different unit, or a bad form. It then gives the full file with 200. An `If-Range` header that does not name the current tag MUST also make the server ignore the `Range` header.

A `HEAD` request MUST get the same status and headers as the `GET`, and no body.

The server MUST stream the body from the open file, and it MUST NOT read a whole file into memory. It MUST run each disk operation of the route off the event loop. A file on a hung mount MUST stop only its own request. The route MUST lift the idle timeout of its connection.

A read that fails after the server sent the status MUST end the body with an error, and the server MUST close the file. The client then gets fewer bytes than `Content-Length`, and it cannot read the cut body as complete.

The route accepts the bearer token or the session cookie of a browser sign-in, as each route under `/api/` does.

#### Scenario: A figure of a run

- **GIVEN** a browser that signed in, and the file `runs/R/A/figures/volcano.png` in the workspace of analysis `a1`
- **WHEN** the browser sends `GET /api/v1/analyses/a1/files?path=runs/R/A/figures/volcano.png` with its session cookie
- **THEN** the server answers 200 with the bytes of the file, `Content-Type: image/png`, `X-Content-Type-Options: nosniff`, and an `ETag`

#### Scenario: A file of a declared input

- **GIVEN** a declared input folder `/data/study`, outside the workspace, that holds `counts.csv`
- **WHEN** a client asks for the absolute path `/data/study/counts.csv`
- **THEN** the server answers 200 with the bytes of the file

#### Scenario: A declared input that is one file

- **GIVEN** a declared input that is the file `/data/run1.csv`
- **WHEN** a client asks for the absolute path `/data/run1.csv`
- **THEN** the server answers 200 with the bytes of the file

#### Scenario: An absolute path inside the workspace

- **GIVEN** no declared input holds the workspace of the analysis
- **WHEN** a client asks for the absolute path of a file in the workspace
- **THEN** the server answers 403 `forbidden`

#### Scenario: A relative path that leaves the workspace

- **WHEN** a client asks for `../other/runs/R/A/figures/volcano.png`, and that file exists outside the workspace
- **THEN** the server answers 403 `forbidden`

#### Scenario: A link that leaves the roots

- **GIVEN** a symbolic link `runs/R/A/leak.txt` in the workspace, to a file outside each readable root
- **WHEN** a client asks for `runs/R/A/leak.txt`
- **THEN** the server answers 403 `forbidden`, and it gives no byte of the target

#### Scenario: A path outside each root

- **WHEN** a client asks for the absolute path of a file outside the workspace and outside each declared input
- **THEN** the server answers 403 `forbidden`

#### Scenario: A part of a file

- **GIVEN** a file of 1000 bytes in the workspace
- **WHEN** a client asks for it with `Range: bytes=0-99`
- **THEN** the server answers 206 with `Content-Range: bytes 0-99/1000` and the first 100 bytes

#### Scenario: A range past the end of the file

- **GIVEN** a file of 1000 bytes in the workspace
- **WHEN** a client asks for it with `Range: bytes=1000-`
- **THEN** the server answers 416 `range_not_satisfiable` with `Content-Range: bytes */1000`

#### Scenario: An unchanged file

- **GIVEN** a client that got a file and its `ETag`
- **WHEN** the client asks for the same file with `If-None-Match` set to that tag, and the file did not change
- **THEN** the server answers 304 with no body

#### Scenario: A changed file

- **GIVEN** a client that got a file and its `ETag`
- **WHEN** a run writes the file again with a different size, and the client asks with `If-None-Match` set to the old tag
- **THEN** the server answers 200 with the new bytes and a different `ETag`

#### Scenario: A download

- **WHEN** a client asks for `runs/R/A/output/de.csv` with `download=1`
- **THEN** the response has `Content-Disposition: attachment` with the file name `de.csv`

#### Scenario: An HTML file runs in a sandbox

- **WHEN** a client asks for an HTML file of the workspace
- **THEN** the response has a `text/html` content type and `Content-Security-Policy: sandbox`

#### Scenario: A HEAD request

- **WHEN** a client sends `HEAD` for a file of the workspace
- **THEN** the server answers 200 with the headers of the `GET`, and no body

### Requirement: The file route refuses a bad request with a named error

The file route MUST give these errors before it sends a status of success:

- 400 `validation_error` when `path` is absent or empty, or holds a NUL byte
- 400 `validation_error` when `download` is present and is not `1`
- 409 `conflict` with the message of the workspace error, when the path is relative and the server cannot locate the workspace root
- 403 `forbidden` when the real path is outside each root of the form of the path
- 404 `not_found` when the path does not exist, and the path is inside a root of its form as text. "As text" means with each `.` and `..` resolved, and no symbolic link resolved. A symbolic link to a path that does not exist, and a loop of symbolic links, also get 404.
- 403 `forbidden` when the path does not exist, and the path is outside each root of its form as text
- 400 `validation_error` when the path names a folder, or a different entry that is not a regular file. A platform can fail the real path of a socket. Then the server cannot do the test of the roots, and the socket gets 403 by the last rule.
- 403 `forbidden` for each other failure of the open or of the facts of the file. The message names the cause, and `details.code` holds the error code of the operating system.

#### Scenario: No path

- **WHEN** a client sends `GET /api/v1/analyses/a1/files` with no `path`
- **THEN** the server answers 400 `validation_error`

#### Scenario: A path that does not exist

- **WHEN** a client asks for `runs/R/A/figures/absent.png`, and the workspace holds no such file
- **THEN** the server answers 404 `not_found`

#### Scenario: An absent path outside each root

- **WHEN** a client asks for an absolute path that does not exist, outside each declared input
- **THEN** the server answers 403 `forbidden`, not 404

#### Scenario: A folder

- **WHEN** a client asks for `runs/R/A/figures`, which is a folder
- **THEN** the server answers 400 `validation_error`

#### Scenario: An unknown analysis

- **WHEN** a client asks for a file of an analysis id that no analysis has
- **THEN** the server answers 404 `not_found`, from the guard of each analysis route
