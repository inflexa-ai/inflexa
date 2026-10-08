# Spec Delta

## RENAMED Requirements

- FROM: `### Requirement: Each API request carries the bearer token`
- TO: `### Requirement: Each API request carries the bearer token or a session cookie`

## MODIFIED Requirements

### Requirement: Each API request carries the bearer token or a session cookie

At its start, the server MUST make a random 256-bit token, and it MUST write the token only to the discovery file. Each request to a path under `/api/` MUST send `Authorization: Bearer <token>`, or the valid session cookie of a browser sign-in (refer to "A browser signs in with a one-time link"). The sign-in request `GET /api/v1/session` needs no credential, because its nonce proves it. `POST /api/v1/session/nonce` accepts only the bearer token. A request with no valid credential MUST get 401 `unauthorized`. The server MUST compare the token in constant time. The token proves that the caller is a process of the OS user that can read the file. One server serves one OS user, thus each client acts as that user: the ask grants MUST use the one user id `local`, and each client can answer each pending ask.

#### Scenario: A request with no token

- **WHEN** a request to `GET /api/v1/projects` sends no `Authorization` header and no session cookie
- **THEN** the server answers 401 with the error `unauthorized`

#### Scenario: A request with a session cookie

- **GIVEN** a browser that signed in through `inflexa gui`
- **WHEN** the browser sends `GET /api/v1/projects` with its session cookie and no `Authorization` header
- **THEN** the server answers 200 with the projects

### Requirement: The routes group by domain and keep the Cortex path tail

The routes MUST be under `/api/v1`, in these groups:

- the server: its state, a new boot, the activity, and the stop
- the machine: the account, the agents and their models, the models of the connection, the settings, and the embedding models
- the projects, the anchors (repair, relocate, prune), and the analyses (resolve, list, make)
- one analysis `{A}` (`/api/v1/analyses/:analysisId`): the analysis itself, its output folder, and its inputs
- the conversation of `{A}`: the threads, the chat, the turns, and the asks
- the runs of `{A}`: the runs, one run, its stream, and its cancel
- the profile of `{A}`: the chat context, the data profile, the sandbox readiness, and the farm heal and link
- the records of `{A}`: the usage, the provenance, and the artifacts
- the package store: the state, the transfers, and the failed flights (retry and delete)
- the browser sign-in (`/api/v1/session`): the nonce and the sign-in link

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

### Requirement: The server answers only a request to its own address

The `Host` header of each request MUST be `127.0.0.1:<port>` or `localhost:<port>`, where the port is the port that the server bound. Otherwise the server MUST answer 403 `forbidden`. An `Origin` header MUST be `http://` with one of the two, or absent. The check MUST run on each path, before the credential check. A web page whose host name points at 127.0.0.1 still sends its own host name, and a page cannot change the two headers. Thus the check stops a DNS rebind.

A request that no socket carried, an `app.request()` call of a test, MUST pass the check.

#### Scenario: A rebound host name

- **WHEN** a request to the server sends the `Host` header `evil.example:8436`
- **THEN** the server answers 403 `forbidden`, and no route runs

#### Scenario: A page of a different origin

- **WHEN** a request sends the correct `Host` header and the `Origin` header `http://evil.example`
- **THEN** the server answers 403 `forbidden`

## ADDED Requirements

### Requirement: The server serves a placeholder page at /gui/

Each server MUST serve one static HTML page at `/gui/`, in each build channel, and it MUST redirect `/gui` there. The page MUST have the text "Not implemented". It MUST hold no script and no token, thus it needs no credential. The page is the target of the browser sign-in of `inflexa gui`.

#### Scenario: A production server serves the page

- **GIVEN** a server of the production channel
- **WHEN** a browser requests `/gui/` with no credential
- **THEN** the server answers 200 with an HTML page whose text is "Not implemented"

#### Scenario: The path with no trailing slash

- **WHEN** a browser requests `/gui`
- **THEN** the server answers 301 to `/gui/`

### Requirement: A browser signs in with a one-time link

The server MUST let a browser sign in with a one-time link and a session cookie. Then each tab of the server origin can use the API, and no page script holds the bearer token.

- `POST /api/v1/session/nonce` MUST need the bearer token. A request that has only a session cookie MUST get 403 `forbidden`. The route MUST answer 201 with `{nonce, expiresAt}`. The nonce MUST be random, MUST work one time, and MUST expire 60 s after the server makes it.
- `GET /api/v1/session?nonce=<nonce>&next=<path>` MUST need no bearer token and no cookie. Only the method `GET` on exactly the path `/api/v1/session` gets this exception.
- The sign-in route MUST read `next` first. An absent `next` MUST mean `/gui/`. A `next` that is not a path of the server origin MUST get 400 `validation_error`, and the nonce MUST stay usable. A path of the server origin holds only the printable ASCII characters from `!` to `~`. It starts with `/`, its second character is not `/`, and it holds no `\`.
- Then the sign-in route MUST read the nonce. An absent, empty, unknown, used, or expired nonce MUST get 401 `unauthorized`, with a message that tells the person to run `inflexa gui` again. A valid nonce MUST be used up. The server MUST make a new random session secret, set it as the session cookie, and answer 303 with `Location: <next>` and `Cache-Control: no-store`.
- The session cookie MUST hold the session secret, never the bearer token. It MUST be `HttpOnly`, `SameSite=Strict`, and `Path=/api`, and it MUST have no `Max-Age` and no `Expires`. The secret MUST be 32 random bytes in hex. Its name MUST be `inflexa_session_<port>`, where `<port>` is the port that the server bound. Cookies ignore the port, thus the production server and the dev server on one host keep separate cookies. A request that no socket carried, an `app.request()` call of a test, uses the name `inflexa_session`.
- The server MUST keep the nonces and the sessions in memory only. It MUST keep the SHA-256 digest of each nonce and of each session secret, and never the nonce or the secret. It MUST find a presented nonce or secret by its digest.
- The server MUST keep at most 32 nonces that are not used, and at most 32 sessions. Before it counts the nonces, it MUST remove each expired nonce. When a new nonce or session goes past the limit, the one of that kind that the server made first MUST go.
- A session cookie MUST be accepted only when the `Sec-Fetch-Site` header is absent, `same-origin`, or `none`. `SameSite=Strict` does not separate the ports of one host, thus this rule refuses a page of a different local port. For a request with a different `Sec-Fetch-Site` value, the server MUST ignore the cookie. Thus such a request with no bearer token gets 401 `unauthorized` with the message for a missing token.
- A request whose session cookie names an unknown session MUST get 401 `unauthorized`, with a message that tells the person to run `inflexa gui` again. After a restart, the server knows no old session. Thus each old cookie gets this answer.

#### Scenario: The bearer token gets a nonce

- **WHEN** a client sends `POST /api/v1/session/nonce` with the bearer token
- **THEN** the server answers 201 with a nonce and the time at which it expires

#### Scenario: A session cookie cannot get a nonce

- **WHEN** a browser sends `POST /api/v1/session/nonce` with a valid session cookie and no `Authorization` header
- **THEN** the server answers 403 `forbidden`

#### Scenario: The sign-in link sets the cookie and moves to the page

- **GIVEN** a nonce that the server made 10 s ago
- **WHEN** a browser opens `/api/v1/session?nonce=<nonce>&next=/gui/`
- **THEN** the server answers 303 to `/gui/`, and it sets an `HttpOnly`, `SameSite=Strict` cookie named `inflexa_session_<port>` with `Path=/api`

#### Scenario: A nonce works one time

- **GIVEN** a nonce that a browser already used
- **WHEN** a browser opens the sign-in link with the same nonce
- **THEN** the server answers 401 `unauthorized`, and the message names `inflexa gui`

#### Scenario: An expired nonce

- **GIVEN** a nonce that the server made 61 s ago
- **WHEN** a browser opens the sign-in link with that nonce
- **THEN** the server answers 401 `unauthorized`, and it sets no cookie

#### Scenario: A next path of a different origin

- **GIVEN** a valid nonce
- **WHEN** a browser opens the sign-in link with `next=//evil.example/`
- **THEN** the server answers 400 `validation_error`, and the nonce stays usable

#### Scenario: A next path with a control character

- **GIVEN** a valid nonce
- **WHEN** a browser opens the sign-in link with `next=/%09/evil.example`
- **THEN** the server answers 400 `validation_error`, because a browser removes the tab and reads `//evil.example`

#### Scenario: A link with no nonce

- **WHEN** a browser opens `/api/v1/session?next=/gui/`
- **THEN** the server answers 401 `unauthorized`, the message names `inflexa gui`, and the server sets no cookie

#### Scenario: A new sign-in with an old cookie

- **GIVEN** a browser that holds the cookie of a server before its restart
- **WHEN** the browser opens a new sign-in link of the restarted server
- **THEN** the server answers 303, and it sets a new cookie of the same name

#### Scenario: A restart ends each session

- **GIVEN** a browser that signed in, and a server that restarted after that
- **WHEN** the browser sends `GET /api/v1/projects` with its old session cookie
- **THEN** the server answers 401 `unauthorized`, and the message tells the person to run `inflexa gui` again

#### Scenario: A page of a different local port

- **GIVEN** a browser that signed in
- **WHEN** the browser sends a request with the session cookie and `Sec-Fetch-Site: same-site`
- **THEN** the server answers 401 `unauthorized` with the message for a missing token

### Requirement: inflexa gui opens the sign-in link

The CLI MUST register `inflexa gui` in each build channel, as an `instance` command with the agent policy `blocked`. Only a person can run it. The command MUST get a nonce from the server with the bearer token. The command MUST print the link `<server origin>/api/v1/session?nonce=<nonce>&next=/gui/`, and say that the link works one time, within 60 s. Then it MUST open the link in the default browser. The server origin is the base URL of the discovery that gave the nonce. When the open fails, the command MUST say so, and the person can open the printed link.

#### Scenario: The command opens the browser

- **GIVEN** a server that answers
- **WHEN** the person runs `inflexa gui`
- **THEN** the command prints the sign-in link with a new nonce and `next=/gui/`, and it opens the link in the default browser

#### Scenario: No browser opens

- **GIVEN** a host with no command that opens a browser
- **WHEN** the person runs `inflexa gui`
- **THEN** the command prints the sign-in link and says that the open failed, and it exits with code 0

#### Scenario: The agent cannot run the command

- **WHEN** the conversation agent asks `run_inflexa` to run `inflexa gui`
- **THEN** the tool refuses it with the reason of the `blocked` policy, and no nonce is made

## REMOVED Requirements

### Requirement: The dev channel serves a web page of the API

**Reason**: Each build now serves a placeholder page at `/gui/` with no token in its URL, and `inflexa gui` signs the browser in. The proof-of-concept page and `bun scripts/poc_gui.ts` go away.

**Migration**: Run `inflexa gui` in place of `bun scripts/poc_gui.ts --open`. Refer to "The server serves a placeholder page at /gui/" and "A browser signs in with a one-time link".
