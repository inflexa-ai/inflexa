# local-server Specification

## Purpose

The local server of the CLI: one process for each OS user and each build channel that holds the harness runtime and the local stores. This spec gives its lifecycle (the bind, the discovery file, the start by a client, the stop), the `server` commands, the import rule of a client, and the conventions of its HTTP API. The TUI, the instance commands, and a later GUI are its clients.

## Requirements

### Requirement: One local server holds the runtime and the local stores

Each OS user MUST have one server process for each build channel. That process MUST hold the harness runtime, the SQLite database, the provenance recorder, and the package store work. The TUI, each `instance` command, and a later GUI MUST be clients of its HTTP API under `/api/v1`. A client MUST NOT boot the harness runtime, and it MUST NOT open the SQLite database. The one exception is the dev `run --plan`, which boots its own runtime. The runtime lock refuses it while a server runs.

The server MUST give no guarantee that the harness and Cortex do not give together. Thus it adds a coordination item only when the harness does not enforce it and a client breaks without it.

The server MUST read the input paths and the anchor markers off the event loop, so a folder on a hung mount stops only its own request.

#### Scenario: Two clients see one state

- **GIVEN** a TUI that is open on an analysis
- **WHEN** a different terminal runs `inflexa project new p1`
- **THEN** the TUI reads the new project at its next read, because both clients use the same server

#### Scenario: A client opens no runtime

- **WHEN** the TUI starts on an analysis
- **THEN** it reads the boot phase from `GET /api/v1/server`, and its own process boots no harness runtime

### Requirement: The server binds the loopback port of its build channel

`inflexa serve` MUST bind `127.0.0.1` only, on the fixed port of its build channel: 8431 for a production build and 8436 for a dev build. It MUST bind the port before it writes the discovery file. Thus a second server fails at the bind, and it never replaces the file of the server that holds the port. A failed bind MUST name the pid of the running server when the discovery file names a live server on that port. Otherwise the message MUST say that a different process holds the port.

#### Scenario: A second server stops at the bind

- **GIVEN** a server that holds port 8436
- **WHEN** a second `inflexa serve` of the dev build starts
- **THEN** it exits with a message that names the pid of the first server, and the discovery file stays as it was

### Requirement: The discovery file names the running server

After the bind, the server MUST write the discovery file `<dataDir>/inflexa/server.json`, or `server.dev.json` for a dev build. The file MUST hold the pid, the port, the bearer token, the package version, the API version, the start time, and the build channel. The server MUST write it with mode 0600, through a temporary file and a rename, so that a reader never sees a part of the file. At its exit, the server MUST remove the file only when the file names its own pid.

A client MUST read the file again at each request. Thus a client that outlives a restart of the server sends the new token.

`INFLEXA_SERVER_FILE` MUST replace the path of the file. A client under this variable MUST NOT start a server, because a different owner starts and stops that server, for example a test.

#### Scenario: The file holds the token with a narrow mode

- **WHEN** the server binds its port
- **THEN** the discovery file exists with mode 0600, and it holds the pid, the port, the token, the versions, the start time, and the channel

#### Scenario: A stop removes only its own file

- **GIVEN** a discovery file that names a different pid
- **WHEN** the server exits
- **THEN** the file stays

#### Scenario: A test names its own server

- **GIVEN** `INFLEXA_SERVER_FILE` names the discovery file of a test server
- **WHEN** an `instance` command runs and the server does not answer
- **THEN** the command fails with the instruction to start the server, and it starts no server

### Requirement: Each API request carries the bearer token or a session cookie

At its start, the server MUST make a random 256-bit token, and it MUST write the token only to the discovery file. Each request to a path under `/api/` MUST send `Authorization: Bearer <token>`, or the valid session cookie of a browser sign-in (refer to "A browser signs in with a one-time link"). The sign-in request `GET /api/v1/session` needs no credential, because its nonce proves it. `POST /api/v1/session/nonce` accepts only the bearer token. A request with no valid credential MUST get 401 `unauthorized`. The server MUST compare the token in constant time. The token proves that the caller is a process of the OS user that can read the file. One server serves one OS user, thus each client acts as that user: the ask grants MUST use the one user id `local`, and each client can answer each pending ask.

#### Scenario: A request with no token

- **WHEN** a request to `GET /api/v1/projects` sends no `Authorization` header and no session cookie
- **THEN** the server answers 401 with the error `unauthorized`

#### Scenario: A request with a session cookie

- **GIVEN** a browser that signed in through `inflexa gui`
- **WHEN** the browser sends `GET /api/v1/projects` with its session cookie and no `Authorization` header
- **THEN** the server answers 200 with the projects

### Requirement: The runtime boots behind the routes

The server MUST start the boot of the harness runtime after it binds its port and writes the discovery file. The boot MUST make the containers, the proxy, and the embedder ready, and then boot the runtime with no analysis. The runtime MUST resolve the farm inventory of each analysis from the session of each call.

`GET /api/v1/server` MUST give the phase (`starting`, `ready`, or `failed`), the versions, and the start time. It MUST add the model connection in the phase `ready`, and the boot error in the phase `failed`. A route that needs the runtime MUST give 503 `unavailable`, with the phase in `details.phase`, until the phase is `ready`. A route that needs only SQLite or the disk MUST work in each phase. `POST /api/v1/server/boot` MUST start the boot again after `failed`, answer 202, and do nothing while a boot runs or after a boot succeeded.

The message of the 503 `unavailable` MUST name the phase. In the phase `failed`, it MUST also give the cause and say that the server boots again after `inflexa up`.

The boot MUST NOT ask for a provider login, also in a terminal. A missing or dead login MUST fail the boot with the reason `sign_in_required` and the remedy `inflexa up` in a terminal. Each other fault of the containers, the proxy, and the embedder MUST fail the boot with the reason `infra_unready`. A fault of the harness boot MUST keep the `type` of the harness error as its reason.

#### Scenario: A SQLite route works while the runtime starts

- **GIVEN** a server whose phase is `starting`
- **WHEN** a client sends `GET /api/v1/analyses`
- **THEN** the server answers 200 with the list

#### Scenario: A runtime route waits for the boot

- **GIVEN** a server whose phase is `failed`
- **WHEN** a client sends `GET /api/v1/analyses/a1/runs`
- **THEN** the server answers 503 `unavailable` with `details.phase` set to `failed`, and the message names the cause and `inflexa up`

#### Scenario: A dead login fails the boot with the sign-in reason

- **GIVEN** a provider login that the provider rejects
- **WHEN** the server boots
- **THEN** no prompt appears, the phase is `failed`, and the boot error has the reason `sign_in_required` and names `inflexa up`

### Requirement: The server state gives the stop and the boot progress

`GET /api/v1/server` and the 202 body of `POST /api/v1/server/boot` MUST give `stopping` in each phase. Its value MUST be the mode of a stop in progress (`now` or `drain`), or `null` while the server runs. A stop that a signal starts MUST give `now`. After the start of a stop, it MUST keep the mode until the process exits. The phase does not change because of a stop.

In the phase `starting`, the body MUST give `boot` with these fields:

- `attemptStartedAt`: the start of the boot attempt.
- `step`: the step that runs now, with its `id` and its `startedAt`. It is `null` before the first step starts.
- `done`: each step of the attempt that ended, in the boot order, with its `id`, its `startedAt`, and its `endedAt`.

The step ids MUST be these, in the boot order: `container_engine`, `proxy`, `images`, `containers`, `credential`, `embedder`, and `runtime`. The steps `proxy` and `credential` MUST run only in `cliproxy` mode. A step ends when the next step starts. A new attempt after `failed` MUST start with an empty `done` list.

While the step `images` pulls an image through the engine API, its `step` MUST give `progress` with `doneBytes` and `totalBytes`. `doneBytes` is the sum of the moved bytes of the pulled images. `totalBytes` is the sum of their sizes, or `null` when a size is not known. A pull that reports no bytes MUST give no `progress`.

In the phase `failed`, the body MUST give `attemptStartedAt`, `failedAt`, and `failedStep`. `failedStep` is the id of the step that ran at the fault. It is `null` for a fault before the first step, for example a model connection that is not valid.

The 503 `unavailable` body of a route that needs the runtime MUST give `details.step` beside `details.phase`. In the phase `starting`, the value is the id of the step that runs now. In the phase `failed`, it is `failedStep`. Before the first step, it is `null`.

Each time MUST be an ISO 8601 string.

#### Scenario: The first boot shows the image pull

- **GIVEN** a server in `cliproxy` mode whose boot pulls the missing images
- **WHEN** a client sends `GET /api/v1/server`
- **THEN** the body has the phase `starting`, `boot.step.id` set to `images`, and the start time of that step
- **AND** `boot.done` gives `container_engine` and `proxy`, each with its start time and its end time

#### Scenario: The pull reports its bytes

- **GIVEN** a boot whose engine socket resolves, and a pull that moved 40 MB of 120 MB
- **WHEN** a client sends `GET /api/v1/server`
- **THEN** `boot.step.progress` gives `doneBytes` 40 MB and `totalBytes` 120 MB

#### Scenario: A drain stop shows in the server state

- **GIVEN** a server in the phase `ready`
- **WHEN** a client sends `POST /api/v1/server/shutdown` with the mode `drain`
- **THEN** each `GET /api/v1/server` until the exit gives `stopping` set to `drain`, and the phase stays `ready`

#### Scenario: A signal stop shows in the server state

- **GIVEN** a server in the phase `ready`
- **WHEN** the server gets SIGTERM
- **THEN** each `GET /api/v1/server` until the exit gives `stopping` set to `now`, and a new chat turn gets 503 `draining`

#### Scenario: A failed boot gives its times and its step

- **GIVEN** a boot that fails while it starts the containers
- **WHEN** a client sends `GET /api/v1/server`
- **THEN** the body has the phase `failed`, `failedStep` set to `containers`, the start time of the attempt, and the time of the failure

#### Scenario: A fault before the first step has no step

- **GIVEN** a model connection that is not valid
- **WHEN** the server boots
- **THEN** the phase is `failed` and `failedStep` is `null`

#### Scenario: A runtime route names the step

- **GIVEN** a server whose boot runs the step `images`
- **WHEN** a client sends `GET /api/v1/analyses/a1/runs`
- **THEN** the server answers 503 `unavailable` with `details.phase` set to `starting` and `details.step` set to `images`

#### Scenario: A new attempt starts with no done step

- **GIVEN** a server in the phase `failed`
- **WHEN** a client sends `POST /api/v1/server/boot`
- **THEN** the body has the phase `starting`, a new `boot.attemptStartedAt`, and no step of the failed attempt in `boot.done`

### Requirement: The boot pulls the missing images through the engine API

The boot gate of the server and of `inflexa up` MUST pull only the images that the engine does not hold. When the engine socket resolves, the gate MUST pull each missing image through the engine API. It MUST report the moved bytes, and the total bytes from the registry manifests. An image reference that pins a digest MUST pull that digest. The step `images` MUST end only when the engine holds each image under the reference of the compose file.

When no engine socket resolves, the gate MUST pull with `compose pull` and report no bytes. For Docker, the socket is the `unix://` path of `DOCKER_HOST`. With no `DOCKER_HOST`, it is the `unix://` endpoint of the current Docker context. The path counts only when it exists on disk. A `DOCKER_HOST` or a context endpoint that is not a unix socket resolves no socket. The gate MUST also use `compose pull` in these conditions:

- The engine API cannot start a pull: the socket does not answer, or the response is not OK.
- An engine pull completes, but the engine does not hold the image under its reference.

An error event in the pull stream of the engine MUST fail the gate with the reason of the engine. A stream that breaks before its end MUST also fail the gate.

The pull MUST write one line at its start and one line for its outcome.

#### Scenario: Podman reports the bytes of the pull

- **GIVEN** a Podman machine that runs, and a Postgres image that the engine does not hold
- **WHEN** the server boots
- **THEN** the gate pulls the image through the engine API, and the step `images` gives the moved bytes and the total bytes

#### Scenario: Docker reports the bytes of the pull

- **GIVEN** Docker as the container runtime, a current context with a unix socket that exists, and a Postgres image that the engine does not hold
- **WHEN** the server boots
- **THEN** the gate pulls the image through the engine API, and the step `images` gives the moved bytes and the total bytes

#### Scenario: A remote Docker daemon pulls with compose

- **GIVEN** Docker as the container runtime, a `DOCKER_HOST` that starts with `tcp://`, and a Postgres image that the engine does not hold
- **WHEN** the server boots
- **THEN** the gate pulls with `compose pull`, and the step `images` gives no `progress`

#### Scenario: The engine refuses a pull

- **GIVEN** an engine socket that resolves, and a pull stream that ends with an error event
- **WHEN** the server boots
- **THEN** the phase is `failed` with the reason `infra_unready`, `failedStep` is `images`, and the message gives the reason of the engine

### Requirement: A client starts a server when none answers

An `instance` command MUST connect to the server before its action runs. The client MUST read the discovery file and probe `GET /api/v1/server` with a limit of 2 s. A server that answers in any phase counts. A file whose pid is dead is stale, and the client MUST remove it, after it reads the file again.

When no server answers, the client MUST take the `server-spawn` lock, read the file again, and run `inflexa serve --detach`. Then it MUST probe until the server answers, up to 30 s. A client that finds the lock held MUST start nothing, and it MUST wait for the server that the holder starts. Thus two clients that find no server start one server. The client MUST tell the person that it starts the server, and it MUST name the server log.

A server whose `apiVersion` differs from the API version of the client MUST be refused, with the instruction to run `inflexa server stop`.

#### Scenario: The first command starts the server

- **GIVEN** no server runs
- **WHEN** the person runs `inflexa ls`
- **THEN** the command starts the server in the background, waits until it answers, and lists the analyses

#### Scenario: Two clients start one server

- **GIVEN** no server runs
- **WHEN** two `instance` commands start at the same time
- **THEN** one of them starts the server, and both use that server

#### Scenario: A server of a different API version

- **WHEN** the server answers with an `apiVersion` that the client does not speak
- **THEN** the command fails, names the two versions, and tells the person to run `inflexa server stop`

### Requirement: inflexa serve runs in the foreground or in the background

`inflexa serve` MUST run the server in the foreground of the terminal, and Ctrl+C MUST stop it. `inflexa serve --detach` MUST start the server as a detached child in a session of its own. The child MUST use the home folder as its working folder, and its stdout and stderr MUST go to the end of the server log. It MUST return when the server answers, or fail with the reason and the path of the log. When a server already answers, `--detach` MUST start no second server and say which server runs.

A server whose output is not a terminal MUST write each step of its boot as plain lines: one line at the start of the step, and one line for its outcome. A spinner frame in the log would be one more line for each frame.

The server log is `<dataDir>/inflexa/logs/server.log`, or `server.dev.log` for a dev build. A detached server MUST measure its log each minute. At 10 MiB, it MUST copy the log to one old file, `<log>.1`, and then truncate the log. A rename is not permitted, because the server keeps the descriptor that it got at its start. `--detach` MUST also do this step before it starts the child.

#### Scenario: The background server outlives its terminal

- **WHEN** the person runs `inflexa serve --detach` and then closes the terminal
- **THEN** the server keeps running, and its output goes to the server log

#### Scenario: A detach finds a running server

- **GIVEN** a server that answers
- **WHEN** the person runs `inflexa serve --detach`
- **THEN** the command starts no server, and it prints the pid and the port of the running server

#### Scenario: A detached boot writes plain lines

- **WHEN** a detached server verifies the provider login during its boot
- **THEN** the server log gets one line for the start of the check and one line for its outcome, and no spinner frame

### Requirement: The server runs until a stop

The server MUST run until one of these stops it: `POST /api/v1/server/shutdown`, Ctrl+C, SIGTERM, or SIGHUP. It MUST NOT exit because no client is connected. Each stop MUST run the shutdown hooks, the runtime shutdown and the provenance flush, and then remove the discovery file and release the instance locks. A second Ctrl+C during the shutdown MUST exit at once.

A stop signal (Ctrl+C, SIGTERM, or SIGHUP) MUST start a `now` stop, and the process MUST exit with 128 + the signal number. A signal during a stop that a client asked for MUST exit at once with that code. The stop then keeps the mode of the client.

At the start of each stop, the server MUST write one line to its output: its pid, the time, and the reason. The reason is the mode that a client asked for, or a stop signal.

`POST /api/v1/server/shutdown` with `{mode}` MUST answer 202 with the mode and the count of the running chat turns, and then stop. A stop MUST refuse each new chat turn at once with 503 `draining`. The mode `drain` MUST wait up to 60 s for the running chat turns. Then each mode MUST abort the turns that still run, wait up to 5 s for them to unwind, and exit. A second stop request MUST start nothing and give the mode of the first. A run is a durable workflow, thus it MUST continue at the next start of a server.

`GET /api/v1/server/activity` MUST give the work that a stop interrupts:

- the mode of a stop in progress
- the count of the running chat turns
- the count of the analyses with a profile drive
- the count of the runs and of the data profiles whose workflow is live, from the count of the live durable work

A ledger read that fails MUST give the state `unreadable`. A server with no runtime MUST give `no_runtime`.

#### Scenario: An idle server stays up

- **GIVEN** a server with no client for one hour
- **WHEN** a client sends a request
- **THEN** the same server process answers

#### Scenario: A drain stop waits for a turn

- **GIVEN** a chat turn that runs
- **WHEN** a client sends `POST /api/v1/server/shutdown` with the mode `drain`
- **THEN** a new chat turn gets 503 `draining`, and the server exits after the running turn ends or after 60 s

#### Scenario: The log tells why the server stopped

- **WHEN** a detached server gets SIGTERM
- **THEN** the server log gets one line with the pid, the time, and the stop signal as the reason

### Requirement: The server commands inspect and stop the server

The `server` commands MUST be `machine` commands: none of them starts a server.

- `inflexa server status` MUST show if a server runs. For a running server, it MUST show the pid, the port, the phase, the start time, the versions, the active work, and the log path. `--json` MUST give the same data as one JSON document. It MUST write nothing: a stale discovery file stays for `server stop`.
- `inflexa server stop` MUST send the stop request with the mode `now`, or `drain` with `--drain`. Then it MUST wait for the exit of the pid, up to 60 s for `now` and 120 s for `drain`. With no server, it MUST say so and succeed. A stale discovery file MUST be removed. A live pid that does not answer MUST fail with the pid to end.
- `inflexa server logs` MUST print the path of the server log and its last lines, 50 by default or `--lines <n>`. `--follow` MUST then print each line that the server appends, also across a rotation, until Ctrl+C. Its cost MUST follow the count of lines, not the size of the file.

#### Scenario: A stop with no server

- **GIVEN** no discovery file
- **WHEN** the person runs `inflexa server stop`
- **THEN** the command prints that no server runs and exits 0

#### Scenario: The status of a running server

- **WHEN** the person runs `inflexa server status --json` and a server answers
- **THEN** the document has the state `running`, the pid, the port, the phase, the versions, the activity, and the log path

### Requirement: An upgrade stops the old server

After `inflexa upgrade` replaces the binary, it MUST stop the server of the old version, so that the next command starts the new one. With no active work, it MUST stop the server with the mode `drain`. With active work, or when the activity read fails, it MUST ask the person first in a terminal. The default answer MUST be No. With no terminal, or with the answer No, the old server MUST keep running, and the command MUST say that `inflexa server stop` stops it.

#### Scenario: An upgrade with a busy server and no terminal

- **GIVEN** a server with a run whose workflow is live
- **WHEN** `inflexa upgrade` completes with no terminal
- **THEN** the old server keeps running, and the command names the work and `inflexa server stop`

### Requirement: A client reaches the server state only through the API

The TUI and the API client MUST read and change the server state only through the HTTP API. A lint rule MUST refuse a static import from the TUI or the API client of these parts: the SQLite layer, the server, the bus, the harness runtime, and a module that holds state or does I/O. The rule MUST permit these parts: the pure harness contracts, the pure data profile view, the pure plan and part readers, the file check of an exported provenance document, and the update module. A type-only import of a server row type MUST also be refused, because each wire type comes from the shared API types.

#### Scenario: The TUI imports the database

- **WHEN** a file of the TUI imports the SQLite query layer
- **THEN** the lint fails with the instruction to call a route of the server

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

Each list MUST take the query values `page` (zero-based, default 0) and `perPage` (default 100, cap 200). A bad value MUST fall back to the default, and it MUST NOT give a 400. A `page` whose offset, the page times `perPage`, is not a safe integer is a bad value. The response MUST be `{<resource>: T[], total, page, perPage, hasMore}`, where the key names the resource. A list MUST add a different field to this shape only when its own requirement names that field, for example `folder` of the folder list.

The transcript read `GET {T}/messages` is the one list that pages by a cursor. It takes `before` and `limit` in place of `page` and `perPage`, as its own requirement states.

#### Scenario: A body that is not JSON

- **WHEN** a client sends `POST /api/v1/projects` with a body that is not JSON
- **THEN** the server answers 400 with the error `invalid_json`

#### Scenario: A bad page value

- **WHEN** a client sends `GET /api/v1/projects?perPage=abc`
- **THEN** the server answers with `perPage` 100

#### Scenario: A page past the safe integers falls back

- **WHEN** a client sends `GET /api/v1/projects?page=99999999999999999999`
- **THEN** the server answers 200 with `page` 0

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

### Requirement: An analysis route checks the analysis and its instance lock

Each route under `/api/v1/analyses/:analysisId` MUST answer 404 `not_found` when no analysis has the id. At the first request for an analysis, the server MUST take the instance lock of that analysis. It MUST hold the lock until it exits. A lock that a different live process holds MUST give 409 `locked` with `details.holderPid`. The lock keeps one provenance recorder on each signed chain across processes, as a fence against an installed binary from before the server.

#### Scenario: An analysis that a different process holds

- **GIVEN** a different live process that holds the instance lock of analysis `a1`
- **WHEN** a client sends `GET /api/v1/analyses/a1`
- **THEN** the server answers 409 `locked` with the pid of the holder

### Requirement: The chat turn and the run stream use SSE

The server MUST use SSE only for the chat turn and for the run stream. Each frame MUST be `data: <JSON>` and a blank line, with no `event:` field and no `id:` field. The stream MUST send the comment `: open` at once, so that the headers go out before the first frame. It MUST send the comment `: ping` each 5 s, because `Bun.serve` closes a connection that is silent for 10 s. No `Last-Event-ID` resume exists: a chat client that connects again reads the transcript, and a run client gets a full replay.

The run stream MUST deliver the parts of the harness run-event reader, and it MUST close when that reader settles. The reader ends a run that has a run row with a terminal part, also a canceled, a suspended, a failed, and a wedged run. The harness `run-event-stream` capability lists the cases with no terminal part. A run of a different analysis MUST get 404 `not_found`. The stream of a data profile workflow MUST close when that workflow ends.

#### Scenario: A quiet run keeps its stream

- **GIVEN** a run stream with no part for 30 s
- **WHEN** the client reads the stream
- **THEN** it gets a `: ping` comment each 5 s, and the connection stays open

#### Scenario: A canceled run closes its stream

- **WHEN** a client cancels a run that a second client streams
- **THEN** the second client gets a `data-run-failed` part with the reason `canceled`, and the stream closes

### Requirement: The chat turn runs apart from its request

`POST {A}/chat` with `{threadId, message}` MUST start one turn in the server. The server MUST make a turn id, register the turn, and send the id in the response header `Inflexa-Turn-Id` when the turn opens. A refusal before the turn opens MUST be a JSON error: 404 for a thread that is absent or of a different analysis, and 500 for a turn that cannot prepare or has no agent. After the open, the stream MUST carry the frames of the turn and of its sub-agents. It MUST end with one `finish` frame for a turn that ended or aborted. It MUST end with one `error` frame for a turn that failed.

A client that disconnects MUST stop only the delivery of the frames, never the turn. `POST {T}/turns/:turnId/abort` MUST abort the turn for each client. `GET {T}/turns` and `GET {T}/turns/:turnId` MUST give the running turns and the newest 100 ended turns, with the status, the usage, and the failure detail of each one. The server MUST NOT refuse a second turn on the same thread, because the harness and Cortex do not serialize turns. At the end of each turn, the server MUST start the flush of the package adds that the turn queued.

#### Scenario: A second client aborts a turn

- **GIVEN** a turn that a TUI started
- **WHEN** a different client sends the abort of its turn id
- **THEN** the turn ends as aborted, and the TUI gets its `finish` frame

#### Scenario: A client leaves during a turn

- **WHEN** the client of a turn closes its connection
- **THEN** the turn runs to its end, and `GET {T}/turns/:turnId` gives its outcome

### Requirement: A rename or a delete waits for no work

A rename of an analysis and a delete of an analysis move or remove its workspace folder. The server MUST refuse them with 409 `busy` while work can hold that folder, and `details.reasons` MUST name the work:

- `chat_turn`: a chat turn of the analysis runs
- `data_profile`: a profile drive is queued or runs, or the profile ledger row is `running`
- `run`: an active run has a live workflow
- `profile_state_unreadable` or `run_state_unreadable`: a ledger read failed

An unreadable state MUST read as busy. With no runtime, only the turn and the profile drive can hold the folder.

One query MUST count the live durable work, for one analysis or for each analysis. The busy gate and the activity of a stop MUST both read it. A workflow is live when its status is `PENDING`, `ENQUEUED`, or `DELAYED`. A run counts when its ledger status is `running`, and a live workflow stands behind it. That workflow is the run, or one of its `<runId>-N` children. A crashed host leaves a `running` row for ever, thus the status of the workflow is the record of liveness. A `suspended_insufficient_funds` run is terminal, thus it never counts.

#### Scenario: A rename during a run

- **GIVEN** an analysis with a run whose workflow is live
- **WHEN** a client renames the analysis
- **THEN** the server answers 409 `busy` with the reason `run`

#### Scenario: A stale run row does not block

- **GIVEN** an analysis with a `running` run row whose workflow is terminal
- **WHEN** a client renames the analysis
- **THEN** the server does not give the reason `run`

#### Scenario: A suspended run does not block

- **GIVEN** an analysis whose only run row reads `suspended_insufficient_funds`
- **WHEN** a client renames the analysis
- **THEN** the server does not give the reason `run`

### Requirement: Polls take the place of the bus

The server MUST NOT give a notification stream. The bus MUST stay inside the server process. Each client MUST read an endpoint again at its own edges and on its own schedule. Each push that a client must see MUST be state that an endpoint returns.

The TUI MUST keep one poll interval while an analysis is open. The interval is 5 s while work is active or a turn of a different client runs on the open thread, and 15 s otherwise. Each tick MUST do these reads:

- the runs and the data profile of the analysis, per `sidebar-live`
- a read of each run that the TUI observed non-terminal and that the runs read of the analysis does not hold, per `run-completion-notice`. The read is `GET {A}/run/:runId`. A run with an open read gets no second read, and at most 4 reads are open at one time.
- a probe of the server, `GET /api/v1/server`, per `tui-harness-chat`

When the server that the boot store saw ready answers the probe, the tick MUST also read these:

- the analysis, `GET {A}` with `touch=false`, per `workspace-context`
- the usage of the open session, per `sidebar-live`
- the turns of the open thread (`GET {T}/turns`, a page of one) and its row (`GET {T}`), per `tui-harness-chat`

Thus an idle TUI sees the work of a different client at most 15 s late.

#### Scenario: A run that a different client started

- **GIVEN** a TUI that is idle on an analysis
- **WHEN** a run of the analysis starts from a different client
- **THEN** the TUI shows the run at its next tick, at most 15 s later

#### Scenario: A server that does not answer gets no more reads

- **GIVEN** a TUI whose server stopped
- **WHEN** the poll ticks
- **THEN** the TUI sends the probe, and it sends no read of the analysis, the usage, or the thread

### Requirement: The server keeps the coordination that one process needs

The server MUST keep these items, because the harness does not enforce them and a client breaks without them:

- The profile drives of each analysis run one at a time, in a queue for each analysis. An arrival queues and does not drop.
- An input change from a route or from the `manage_inputs` tool starts the re-profile in the server.
- The oldest pending package add starts the flush after 10 s, also with no client.

The input change MUST arm a 500 ms timer for its analysis. When the timer fires before the runtime is ready, it MUST arm again, thus the drive runs at the first fire after the ready edge. When the sandbox gate refuses, the change MUST arm again after 30 s, because no event tells the server that a download ended. `GET {A}/data-profile` MUST give `workPending: true` while the server holds profile work that the ledger row does not show yet: a change that waits, or a drive that is queued or runs.

The server MUST NOT keep a write queue for each thread, because the harness locks each write of a thread. It MUST NOT write a run outcome into the transcript, because no harness or Cortex code writes that record.

#### Scenario: Two input changes queue

- **GIVEN** a profile drive of analysis `a1` that runs
- **WHEN** a client adds an input to `a1`
- **THEN** a second drive runs after the first, against the new inputs

#### Scenario: An input change waits for the sandbox

- **GIVEN** an analysis with inputs, and no sandbox image on the machine
- **WHEN** a client adds an input to the analysis
- **THEN** no drive starts, the data profile route gives `workPending: true`, and the change asks the gate again after 30 s

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

### Requirement: inflexa up signs in and boots a failed server again

`inflexa up` MUST make the machine ready for the server: the containers, the proxy, the provider login, and the embedder. It runs the gate of the server boot, but on a terminal it MUST offer the provider sign-in that the boot cannot offer. When the gate fails, the command MUST print the reason, exit with code 1, and send no boot request.

When the gate succeeds, the command MUST read the discovery file. A server whose phase is `failed` MUST get `POST /api/v1/server/boot`, and the command MUST say that the server boots again. No server, or a server in a different phase, MUST get no request, because a later boot finds the machine ready. `inflexa up` stays a `machine` command, thus it starts no server.

#### Scenario: A sign-in repairs a failed boot

- **GIVEN** a server whose boot failed with the reason `sign_in_required`
- **WHEN** the person runs `inflexa up` in a terminal and signs in
- **THEN** the command sends `POST /api/v1/server/boot`, and the server boots again

#### Scenario: No server runs

- **GIVEN** no server runs
- **WHEN** `inflexa up` succeeds
- **THEN** the command starts no server and sends no boot request

### Requirement: Each profile drive of the server asks the sandbox gate first

Before each profile drive, the server MUST ask why a sandbox of the analysis cannot start now. The drives are the chat open (`GET {A}/chat-context`), the deliberate re-profile (`POST {A}/data-profile/rerun`), and the input change. The gate MUST give one line for a person with the command that repairs the machine, or nothing:

- An analysis with no inputs profiles nothing, thus it MUST pass.
- A live image or catalog transfer MUST refuse, and name `inflexa sandbox status`.
- A container engine that does not answer MUST refuse with the message of the engine.
- An image that the engine cannot find MUST refuse, and name `inflexa sandbox pull`, or the build of a custom image.
- An absent or incomplete store MUST refuse, and name `inflexa store download`. A declined or canceled catalog transfer gives the reason.
- A recorded failure of the farm composition MUST refuse with its reason. The gate of the chat open and of the deliberate re-profile clears the record when it reads the machine, thus the next drive composes again. The gate of the input change MUST NOT clear the record, because no person sees its refusal. Thus the input change waits until a drive of a person names the failure.

The engine and the filesystem decide usability, and a transfer row gives only the reason of a refusal. A refused re-profile MUST give 409 `conflict` with the line. A refused chat open MUST give the outcome `failed` with the line, and start no drive. A refused input change MUST wait, per the coordination requirement.

The read of the sandbox readiness (`GET {A}/sandbox-readiness`) MUST give a recorded failure of the farm composition in `farm.failure`. That read MUST NOT clear the record. Thus the read changes no state, and the next drive can name the cause.

#### Scenario: A re-profile with no sandbox image

- **GIVEN** an analysis with inputs, and no sandbox image in the engine
- **WHEN** a client sends `POST {A}/data-profile/rerun`
- **THEN** the server answers 409 `conflict` with the line that names `inflexa sandbox pull`, and nothing is staged

#### Scenario: A chat open during a transfer

- **GIVEN** a live catalog transfer
- **WHEN** a client sends `GET {A}/chat-context` for an analysis with inputs
- **THEN** the profile outcome is `failed` with the transfer line, and no drive starts

#### Scenario: A readiness read leaves the farm failure for the gate

- **GIVEN** a recorded failure of the farm composition of an analysis with inputs, a sandbox image in the engine, and a complete store
- **WHEN** a client sends `GET {A}/sandbox-readiness` two times, and then sends `POST {A}/data-profile/rerun`
- **THEN** each readiness answer gives the failure in `farm.failure`
- **AND** the re-profile answers 409 `conflict` with the line that names the failure

#### Scenario: The gate clears the record that it read

- **GIVEN** a recorded failure of the farm composition of an analysis with inputs
- **WHEN** a profile drive asks the gate, and the gate refuses with the failure
- **THEN** the next read of the sandbox readiness gives `farm.failure` as `null`

#### Scenario: An input change leaves the record for a person

- **GIVEN** a recorded failure of the farm composition of an analysis with inputs
- **WHEN** the input change asks the gate two times, and then a client sends `POST {A}/data-profile/rerun`
- **THEN** each input-change check refuses with the failure, and the re-profile answers 409 `conflict` with the line that names the failure

### Requirement: The settings give the data folder and the server log

The body of `GET` and `PATCH /api/v1/settings` MUST give two absolute paths on the server machine:

- `dataDir`: the data folder of inflexa, `<data dir>/inflexa`. The database, the logs, and the package store are in it.
- `serverLogPath`: the log file of a background server of this build channel. `inflexa server logs` reads the same file.

The two paths come from the data home of the platform (`XDG_DATA_HOME`, or `LOCALAPPDATA` on Windows). The paths MUST be absolute. A relative data home MUST be ignored, as the XDG Base Directory specification says, and the paths then use the default data home under the home folder.

A `PATCH` body cannot change the two paths. The server MUST ignore them in a `PATCH` body.

#### Scenario: The settings name the data folder

- **WHEN** a client sends `GET /api/v1/settings`
- **THEN** `dataDir` is the absolute path of `<data dir>/inflexa`
- **AND** `serverLogPath` is the absolute path of the server log of this build channel

#### Scenario: A patch does not move the data folder

- **WHEN** a client sends `PATCH /api/v1/settings` with `{ "telemetry": true, "dataDir": "/tmp/x" }`
- **THEN** the server saves `telemetry`, and the answer gives the same `dataDir` as before

### Requirement: The server gives the sandbox readiness of the machine

`GET /api/v1/sandbox` MUST give the parts of the sandbox readiness that do not depend on an analysis:

- `image`: the state of the configured sandbox image in the container engine, with the type of `image` in `GET {A}/sandbox-readiness`
- `store`: the state of the content of the package store, with the type of `store` in `GET {A}/sandbox-readiness`
- `catalogFarmPresent`: true when the catalog farm exists. It is equal to `farm.catalogPresent` of `GET {A}/sandbox-readiness`.

The read MUST change no state. It MUST NOT pull an image, write the configuration, or clear a recorded failure of a farm composition. It MUST NOT change a transfer row or a flight row. The route MUST answer when the runtime did not boot. The engine read can take more than 10 s, thus the route MUST lift the idle timeout of the connection.

A container engine that does not answer is a state of `image`, not an error of the route. The route MUST answer 200 with `image.state` `engine_error` and the message of the engine.

#### Scenario: A machine with no sandbox image

- **GIVEN** a container engine that does not hold the published sandbox image, an installed package store, and no catalog farm
- **WHEN** a client sends `GET /api/v1/sandbox`
- **THEN** the server answers 200 with `image.state` `absent`, `store` `installed`, and `catalogFarmPresent` `false`

#### Scenario: The machine read leaves the farm failure

- **GIVEN** a recorded failure of the farm composition of analysis `a1`
- **WHEN** a client sends `GET /api/v1/sandbox`, and then sends `GET /api/v1/analyses/a1/sandbox-readiness`
- **THEN** the readiness of `a1` gives the failure in `farm.failure`

#### Scenario: An engine that does not answer

- **GIVEN** a container engine that does not answer
- **WHEN** a client sends `GET /api/v1/sandbox`
- **THEN** the server answers 200 with `image.state` `engine_error` and the message of the engine

### Requirement: A page opens a known folder through the server

`POST /api/v1/open-directory` MUST open a known folder of the server machine in the file manager of the OS user. A browser page cannot open a folder. The server listens on the loopback address only, thus the desktop of the server is the desktop of the page. The endpoint opens directories only; it MUST NOT open a file. The server MUST apply this rule to the resolved path of every target before the open: a resolved path that names nothing on disk MUST give 404 `not_found`, and one that names a file MUST give 409 `conflict`.

The body MUST name the folder by a target, never by a path or a URL that the server opens outside a jail:

- `{ "target": "data_dir" }`: the data folder, the `dataDir` of the settings
- `{ "target": "output_dir", "analysisId": "<id>" }`: the output folder of the analysis that has the id
- `{ "target": "workspace", "analysisId": "<id>", "path": "<relative path>" }`: the folder at `path` inside the workspace of the analysis
- `{ "target": "input", "analysisId": "<id>", "path": "<reference path>", "anchorId": "<anchor id> or null" }`: the folder of one registered input of the analysis; inputs live outside the workspace. The body MUST carry `anchorId`; `null` names an unanchored reference
- `{ "target": "logs_dir" }`: the log folder of the server
- `{ "target": "reference_store" }`: the folder of the reference datasets
- `{ "target": "package_store" }`: the folder of the packages

The server MUST NOT open a path or a URL that the body names outside these jails. A `workspace` path names a location only inside the workspace of the analysis the page already views, and an `input` reference names a folder only when the analysis already registers it. Thus a page cannot make the server open a folder that the viewed analysis does not already name in its workspace or in its registered inputs.

The server MUST resolve a `workspace` path with the same rule as the `workspace-file` kind of `POST {A}/artifacts/resolve`: the path MUST be relative, with no `..` segment, and the server tests the real path of the target, with each symbolic link resolved, against the real path of the workspace root. A path of `.` names the workspace root itself. A path whose form is not a valid relative path MUST give 400 `validation_error`. A path that resolves outside the workspace, also through a symbolic link, MUST give 404 `not_found`, and the server MUST open nothing. A path that resolves inside the workspace but names nothing on disk MUST give 404 `not_found`. A path that names a file MUST give 409 `conflict`, because the endpoint opens directories only. A `workspace` target whose workspace root cannot be resolved, for example an anchor folder that is gone, MUST give 409 `conflict` with the reason.

The server MUST resolve an `input` reference by an exact comparison of the reference pair: the `path` and `anchorId` of the body MUST equal the stored `path` and `anchorId` of one registered input of the analysis. The server MUST NOT match a resolved absolute path, a name, or any other form. An anchored reference path is relative to its anchor. An unanchored reference path is an absolute path, and the server accepts it only because it opens the path when the analysis registers that exact reference. A reference that matches no registered input MUST give 404 `not_found`. An input whose reference is a file (`isDir` false) MUST give 409 `conflict` without a disk probe, because the endpoint opens directories only. A resolved input path that names a file on disk MUST give 409 `conflict`. An input whose anchor folder cannot be found MUST give 409 `conflict` with the reason. A resolved input path that names nothing on disk MUST give 404 `not_found`.

The server MUST refuse a body that names no known target with 400 `validation_error`, and open nothing. An `output_dir` or `workspace` or `input` body with no `analysisId` is such a body. A body that is not JSON gives the `invalid_json` answer of the server's error table. The server MUST match the `analysisId` exactly, the same way for every target that carries one: a name or a slug of an analysis is not the id. When no analysis has the `analysisId`, the server MUST answer 404 `not_found` and open nothing.

The server MUST resolve the output folder as `POST {A}/output-dir` does. It gives an existing folder as it is. It makes an absent folder, which needs a writable anchor folder. A failure MUST give the answer of `POST {A}/output-dir`, and the server MUST open nothing:

- The anchor folder of the analysis cannot be found, or it is not writable for a make: 409 `conflict` with the reason.
- Each other failure, for example a failed make of the folder: 500 `internal_error`.

The server MUST resolve `logs_dir` as it is, because the log of the server is in it while the server runs. An absent `logs_dir` MUST give 404 `not_found`, and a file at that path MUST give 409 `conflict`. The server MUST resolve `reference_store` and `package_store` as an existing folder as it is, and MUST make an absent folder before the open. A file where a store folder belongs MUST give 409 `conflict`. A failed make MUST give 500 `internal_error`. In each case the server MUST open nothing.

Each 409 `conflict` answer MUST carry a reason that names the case.

The answer MUST be 200 `{ "opened": boolean }`. `opened` is true when the server started the opener of the OS. It is false when the server cannot start an opener, for example on a machine with no opener program. A failed open MUST NOT give an error status.

#### Scenario: A page opens the data folder

- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "data_dir" }`
- **THEN** the server opens the data folder in the file manager, and answers `{ "opened": true }`

#### Scenario: A page opens an output folder that does not exist yet

- **GIVEN** analysis `a1` in a writable folder, with no output folder
- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "output_dir", "analysisId": "a1" }`
- **THEN** the server makes the output folder of `a1`, opens it, and answers `{ "opened": true }`

#### Scenario: An output folder with no analysis id

- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "output_dir" }`
- **THEN** the server answers 400 `validation_error`, and it opens nothing

#### Scenario: A path in place of a target

- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "/etc" }`
- **THEN** the server answers 400 `validation_error`, and it opens nothing

#### Scenario: An unknown analysis

- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "output_dir", "analysisId": "nope" }`, and no analysis has the id `nope`
- **THEN** the server answers 404 `not_found`, and it opens nothing

#### Scenario: An analysis whose folder is gone

- **GIVEN** analysis `a1` whose anchor folder was deleted
- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "output_dir", "analysisId": "a1" }`
- **THEN** the server answers 409 `conflict` with the reason, and it opens nothing

#### Scenario: A machine with no opener

- **GIVEN** a server machine with no opener program
- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "data_dir" }`
- **THEN** the server answers 200 with `{ "opened": false }`

#### Scenario: A page opens the folder of a run

- **GIVEN** analysis `a1` whose workspace holds the folder `runs/r1`
- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "workspace", "analysisId": "a1", "path": "runs/r1" }`
- **THEN** the server opens the folder `runs/r1` of the workspace of `a1`, and answers `{ "opened": true }`

#### Scenario: A workspace path with a `..` segment

- **GIVEN** analysis `a1` with a workspace root at `/home/u/ws`
- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "workspace", "analysisId": "a1", "path": "../elsewhere" }`
- **THEN** the server answers 400 `validation_error`, and it opens nothing

#### Scenario: A workspace path that escapes through a symbolic link

- **GIVEN** analysis `a1` whose workspace holds a symbolic link `link` that points to `/etc`
- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "workspace", "analysisId": "a1", "path": "link" }`
- **THEN** the server answers 404 `not_found`, and it opens nothing

#### Scenario: A workspace path that names nothing on disk

- **GIVEN** analysis `a1` whose workspace holds no folder `runs/r9`
- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "workspace", "analysisId": "a1", "path": "runs/r9" }`
- **THEN** the server answers 404 `not_found`, and it opens nothing

#### Scenario: A workspace path that names a file

- **GIVEN** analysis `a1` whose workspace holds the file `runs/r1/synthesis.json`
- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "workspace", "analysisId": "a1", "path": "runs/r1/synthesis.json" }`
- **THEN** the server answers 409 `conflict`, and it opens nothing

#### Scenario: A workspace whose anchor folder is gone

- **GIVEN** analysis `a1` whose anchor folder was deleted
- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "workspace", "analysisId": "a1", "path": "runs/r1" }`
- **THEN** the server answers 409 `conflict` with the reason, and it opens nothing

#### Scenario: A page opens the folder of a step output

- **GIVEN** analysis `a1` whose workspace holds the folder `runs/r1/s1/output`
- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "workspace", "analysisId": "a1", "path": "runs/r1/s1/output" }`
- **THEN** the server opens that folder, and answers `{ "opened": true }`

#### Scenario: A page opens the folder of a registered input

- **GIVEN** analysis `a1` with a registered folder input under the anchor `an1`
- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "input", "analysisId": "a1", "path": "<the reference path of the input>", "anchorId": "an1" }`
- **THEN** the server opens the folder of that input outside the workspace, and answers `{ "opened": true }`

#### Scenario: An input reference that names a file

- **GIVEN** analysis `a1` with an unanchored registered input whose reference is a file
- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "input", "analysisId": "a1", "path": "<the absolute reference path of that input>", "anchorId": null }`
- **THEN** the server answers 409 `conflict` without a disk probe, and it opens nothing

#### Scenario: An input whose folder became a file

- **GIVEN** analysis `a1` with a registered input whose record names a folder, and the path on disk holds a file now
- **WHEN** a page sends `POST /api/v1/open-directory` with the reference of that input
- **THEN** the server answers 409 `conflict`, and it opens nothing

#### Scenario: A reference with a wrong anchor

- **GIVEN** analysis `a1` with a registered input under the anchor `an1`
- **WHEN** a page sends `POST /api/v1/open-directory` with the `path` of that input and the anchor `an2`
- **THEN** the server answers 404 `not_found`, and it opens nothing

#### Scenario: An input reference that matches no registered input

- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "input", "analysisId": "a1", "path": "/not/registered", "anchorId": null }`
- **THEN** the server answers 404 `not_found`, and it opens nothing

#### Scenario: An input whose anchor folder is gone

- **GIVEN** analysis `a1` with a registered folder input under the anchor `an1`, and the folder of the anchor `an1` was deleted
- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "input", "analysisId": "a1", "path": "<the reference path of the input>", "anchorId": "an1" }`
- **THEN** the server answers 409 `conflict` with the reason, and it opens nothing

#### Scenario: A page opens the log folder

- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "logs_dir" }`
- **THEN** the server opens the log folder, and answers `{ "opened": true }`

#### Scenario: A log folder that is absent

- **GIVEN** a server whose log folder was removed
- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "logs_dir" }`
- **THEN** the server answers 404 `not_found`, and it opens nothing

#### Scenario: A page opens the reference store that does not exist yet

- **GIVEN** a server whose reference-dataset folder was never made
- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "reference_store" }`
- **THEN** the server makes the folder, opens it, and answers `{ "opened": true }`

#### Scenario: A page opens the package store

- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "package_store" }`
- **THEN** the server opens the package-store folder, and answers `{ "opened": true }`

#### Scenario: A file where a store folder belongs

- **GIVEN** a server whose package-store path holds a file, not a folder
- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "package_store" }`
- **THEN** the server answers 409 `conflict`, and it opens nothing

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

### Requirement: The folder list refuses a bad path with a named error

The list route MUST answer 400 `validation_error` when `path` is absent, is not absolute, or holds a NUL byte. It MUST also answer 400 `validation_error` when `hidden` is present and is not `true` or `false`. It MUST answer 404 `not_found` when the folder does not exist. It MUST answer 400 `validation_error` when the path names a file. Each other failure of the folder read MUST give 403 `forbidden`. The message MUST name the cause, and `details.code` MUST hold the error code of the operating system, for example `EACCES`.

#### Scenario: No path

- **WHEN** a client sends `GET /api/v1/fs/list` with no `path`
- **THEN** the server answers 400 `validation_error`

#### Scenario: A relative path

- **WHEN** a client sends `GET /api/v1/fs/list?path=data`
- **THEN** the server answers 400 `validation_error`

#### Scenario: An absent folder

- **WHEN** a client lists an absolute path that does not exist
- **THEN** the server answers 404 `not_found`

#### Scenario: A path that names a file

- **WHEN** a client lists the absolute path of a file
- **THEN** the server answers 400 `validation_error`

#### Scenario: An unreadable folder

- **GIVEN** a folder whose mode is 000, and a server that does not run as root
- **WHEN** a client lists the folder
- **THEN** the server answers 403 `forbidden`, the message names the denied permission, and `details.code` is `EACCES`

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

### Requirement: The analysis list gives a summary of each analysis

Each item of `GET /api/v1/analyses` MUST carry the analysis view, `anchorPath`, and `usage` when the usage read succeeds. Each item MUST also carry these fields:

- `lastActivityAt`: the stored activity time of the analysis, as an ISO 8601 string.
- `folderPresent`: `true` when the cached anchor path exists on disk at the request. It is `false` when the path is `null` or does not exist.
- `profile`: `{ status, profiledFiles, completedAt }` from the grouped profile read of the harness, or `null`.
- `latestRun`: `{ runId, status, planTitle, doneSteps, totalSteps, startedAt, completedAt }` from the grouped newest-run read of the harness, or `null`. `planTitle` is `null` when the run has no title.
- `pendingAsks`: the count of the pending asks of the analysis, or `null`.
- `busy`: the busy reasons that `GET {A}` gives for the same state of the server.

The `sort` query value MUST select the order. `activity` orders by the activity time, newest first. `created` orders by the creation time, newest first, and it is the default. An absent or empty `sort` selects the default. Each order MUST break a tie with the id, so that two pages never overlap. A different value MUST give 400 `validation_error` with the field error under `sort`. The `project` filter MUST apply to each order.

The count of the database reads of one request MUST NOT depend on the page size. The SQLite reads are the page, the total, and the grouped usage, plus the project resolve when `project` is set. When the phase is `ready`, the Postgres reads are these:

- one grouped newest-run read
- one grouped profile read
- one grouped read of the live durable work, with the liveness rule of the busy gate
- one `askGateway.pending()` call

The existence checks of the anchor paths MUST run with a bounded width.

The route reads only SQLite and the disk before the phase is `ready`, thus it MUST answer in each phase. Until the phase is `ready`, `profile`, `latestRun`, and `pendingAsks` MUST be `null`. Then `busy` MUST hold only the reasons that the server knows with no runtime: the chat turn and the profile drive. The SQLite fields MUST stay.

A Postgres read that fails MUST NOT fail the list. This includes the `askGateway.pending()` call. The field of that read MUST be `null` on each item, and the failure MUST go to the log. A failed profile read MUST add `profile_state_unreadable` to the busy reasons of each item with no profile drive. A failed live-work read MUST add `run_state_unreadable` to the busy reasons of each item. The rule of the busy gate is the same: an unreadable state reads as busy.

#### Scenario: A page sorted by activity

- **GIVEN** 30 analyses, each with runs and a profile, in a server whose phase is `ready`
- **WHEN** a client sends `GET /api/v1/analyses?sort=activity&perPage=20`
- **THEN** the server gives the 20 analyses with the newest activity, newest first, each with its summary
- **AND** it sends the same count of Postgres reads as for `perPage=1`

#### Scenario: The list during the boot

- **GIVEN** a server whose phase is `starting`
- **WHEN** a client sends `GET /api/v1/analyses`
- **THEN** the server answers 200
- **AND** each item has `lastActivityAt` and `folderPresent`, and `profile`, `latestRun`, and `pendingAsks` are `null`

#### Scenario: A bad sort value

- **WHEN** a client sends `GET /api/v1/analyses?sort=name`
- **THEN** the server answers 400 `validation_error` with a field error under `sort`

#### Scenario: A run with a live workflow

- **GIVEN** an analysis whose newest run is `running` with a live workflow
- **WHEN** a client lists the analyses
- **THEN** its item has `latestRun.status` `running`, and `busy` holds `run`

#### Scenario: A folder that is gone

- **GIVEN** an analysis whose cached anchor path no longer exists
- **WHEN** a client lists the analyses
- **THEN** its item has `folderPresent` `false`

#### Scenario: A failed run read does not fail the list

- **GIVEN** a server whose grouped newest-run read fails
- **WHEN** a client lists the analyses
- **THEN** the server answers 200, and each item has `latestRun` `null`

#### Scenario: A failed ask read does not fail the list

- **GIVEN** a server whose `askGateway.pending()` call rejects
- **WHEN** a client lists the analyses
- **THEN** the server answers 200, and each item has `pendingAsks` `null`

### Requirement: The server records the activity of each analysis

The server MUST raise the activity time of an analysis at each activity. These are the activities and their times:

- A write that changes the analysis row: the insert, the rename, the set or the clear of its project, and the clear by a project delete. The time is the time of the write.
- A chat turn of the analysis. The time is the open of the turn and the end of the turn.
- An answer of an ask that the gateway applied. The time is the time of the answer.
- An input add or an input removal. A subscriber of `prov.input_added` and `prov.input_removed` takes the time of the event delivery.
- A run start and a run end. A subscriber of `prov.run_started` takes the start time of the event. A subscriber of `prov.run_completed` takes the completion time of the event.
- A profile settle. The composition root binds the settle notice of the harness, and the notice gives the completion time.

A raise MUST keep the later of the stored time and the new time, thus a raise never lowers the time. A run event fires again after a recovery with the same time from the durable clock, thus it changes nothing. A raise MUST NOT change `updated_at`. A raise for an id with no row MUST change nothing, and it is not an error. A raise that fails MUST go to the log, and it MUST NOT fail the action that caused it.

#### Scenario: An input add moves an analysis to the top

- **GIVEN** analyses `a1` and `a2`, where `a2` has the newer activity
- **WHEN** a client adds an input to `a1`
- **THEN** `GET /api/v1/analyses?sort=activity` gives `a1` first

#### Scenario: A recovered run does not move the time

- **GIVEN** an analysis whose activity time is the completion time of its run
- **WHEN** the runtime recovers and fires `prov.run_completed` of that run again
- **THEN** the activity time does not change

#### Scenario: A profile settle raises the time

- **WHEN** the profile of an analysis settles, and the harness gives the settle notice
- **THEN** the activity time of the analysis is the completion time of the notice

#### Scenario: An old event time does not lower the time

- **GIVEN** an analysis whose activity time is later than the start time of a run event
- **WHEN** the subscriber gets that `prov.run_started`
- **THEN** the activity time does not change

### Requirement: The attention read gives the work that waits for the person

`GET /api/v1/attention` MUST give four lists over each analysis: `asks`, `activeRuns`, `unseenRuns`, and `recentThreads`. The route reads Postgres, thus it MUST answer 503 `unavailable` until the phase is `ready`.

The lists MUST hold these items:

- `asks`: each pending ask of the ledger, the oldest first. An item carries `askId`, `analysisId`, `analysisName`, `threadId`, `title`, `command`, `createdAt`, and `stale`. `stale` is `true` when no turn of the turn registry runs on the thread of the ask. An ask with no thread is stale.
- `activeRuns`: each run with a live workflow, by the liveness rule of the busy gate, the newest start first. An item carries `runId`, `analysisId`, `analysisName`, `threadId`, `planTitle`, `doneSteps`, `totalSteps`, and `startedAt`. `planTitle` and `threadId` are `null` when the run has none. A run whose progress read gives a terminal status ended between the two reads, and the list MUST leave it out.
- `unseenRuns`: each run that has no seen mark, among the newest 200 terminal runs that ended at or after the seen baseline, the newest end first. An unseen run that is older than these 200 runs is absent. An item carries `runId`, `analysisId`, `analysisName`, `status`, and `completedAt`.
- `recentThreads`: the newest live conversation threads, the newest update first. An item carries the fields of a thread on the wire and `analysisName`.

`activeRuns` and `unseenRuns` MUST each hold at most 200 items. The `limit` query value sets the count of `recentThreads`. A value that is not a positive integer selects 10. A value above 200 selects 200.

Each item MUST name an analysis that has a SQLite row, and `analysisName` is the name of that row. The read MUST leave out an item whose analysis has no row, because no `{A}` route can open it. When the seen baseline is absent, `unseenRuns` MUST be empty.

The count of the reads of one request MUST NOT depend on the count of analyses or of items. The Postgres reads are these:

- one `askGateway.pending()` call
- one read of the live runs
- one progress read of those runs, and none when no run is live
- one read of the newest 200 runs that ended at or after the seen baseline, and none when the seen baseline is absent. The read gets no list of seen marks.
- one read of the newest threads

The SQLite reads are the read of the seen baseline, the read of the seen marks of the ended runs of that read, and the read of the names of the analyses. Each sends a fixed count of statements. The count of the seen marks MUST NOT change the size of a read. A failed read MUST give 500 `internal_error`, and the failure MUST go to the log.

#### Scenario: An ask and a run of two analyses

- **GIVEN** an open ask in analysis `a1` and a run with a live workflow in analysis `a2`
- **WHEN** a client sends `GET /api/v1/attention`
- **THEN** `asks` holds the ask with the name of `a1`, and `activeRuns` holds the run with the name of `a2`

#### Scenario: An ask with no turn is stale

- **GIVEN** an open ask whose thread has no running turn, for example after the server started again
- **WHEN** a client reads the attention lists
- **THEN** the item of the ask has `stale` `true`

#### Scenario: An ask with no thread is stale

- **GIVEN** an open ask whose `threadId` is `null`
- **WHEN** a client reads the attention lists
- **THEN** the item of the ask has `stale` `true`

#### Scenario: A run that ended between the reads

- **GIVEN** a run that the live-run read gives, and whose progress read gives the status `completed`
- **WHEN** a client reads the attention lists
- **THEN** `activeRuns` does not hold the run

#### Scenario: A run that ended before the change counts as seen

- **GIVEN** a terminal run whose `completed_at` is before the seen baseline
- **WHEN** a client reads the attention lists
- **THEN** `unseenRuns` does not hold the run

#### Scenario: The seen marks do not change the size of a read

- **GIVEN** seen marks of runs that are not among the newest 200 ended runs, and a seen mark of run `r1` among them
- **WHEN** a client reads the attention lists
- **THEN** the ended-run read gets no run ids, the read of the seen marks gets only the ids of the newest 200 ended runs, and `unseenRuns` does not hold `r1`

#### Scenario: The count of the reads is fixed

- **WHEN** a client reads the attention lists over 1 analysis and then over 20 analyses
- **THEN** the server sends the same count of reads for the two requests

#### Scenario: The read during the boot

- **GIVEN** a server whose phase is `starting`
- **WHEN** a client sends `GET /api/v1/attention`
- **THEN** the server answers 503 `unavailable`

#### Scenario: An analysis with no row

- **GIVEN** a pending ask of an analysis id that has no SQLite row
- **WHEN** a client reads the attention lists
- **THEN** `asks` does not hold the ask

#### Scenario: The default count of the threads

- **GIVEN** 12 live conversation threads over three analyses
- **WHEN** a client sends `GET /api/v1/attention` with no `limit`
- **THEN** `recentThreads` holds the 10 newest

### Requirement: A person marks a terminal run as seen

`POST {A}/run/:runId/seen` MUST record a seen mark of the run in SQLite, and answer 200 with `{ seen: true }`. A second mark of the same run MUST keep the first mark and answer 200. An unknown run, or a run of a different analysis, MUST give 404 `not_found`. A run whose status is not terminal MUST give 409 `conflict`, and the route MUST record nothing. The route reads the run ledger, thus it MUST answer 503 `unavailable` until the phase is `ready`.

The mark is a fact of this machine, thus SQLite keeps it. SQLite also keeps the seen baseline: the time of the migration that adds the marks. A terminal run that ended before the baseline counts as seen with no mark. A mark is not an activity, thus it MUST NOT raise the activity time of the analysis. A delete of an analysis MUST remove its marks.

#### Scenario: A seen run leaves the list

- **GIVEN** a terminal run `r1` of analysis `a1` in `unseenRuns`
- **WHEN** a client sends `POST /api/v1/analyses/a1/run/r1/seen`
- **THEN** the server answers 200, and `unseenRuns` no longer holds `r1`

#### Scenario: A run that runs cannot be seen

- **GIVEN** run `r1` of analysis `a1` with the status `running`
- **WHEN** a client sends `POST /api/v1/analyses/a1/run/r1/seen`
- **THEN** the server answers 409 `conflict`, and SQLite holds no mark of `r1`

#### Scenario: A run of a different analysis

- **GIVEN** run `r1` of analysis `a2`
- **WHEN** a client sends `POST /api/v1/analyses/a1/run/r1/seen`
- **THEN** the server answers 404 `not_found`

### Requirement: A thread on the wire carries its running turn and its open asks

Each thread that a route gives MUST carry `runningTurnId` and `pendingAsks`. The routes are `GET {A}/threads`, `GET {T}`, `PATCH {T}`, `POST {T}/restore`, and the items of `recentThreads` of the attention read.

- `runningTurnId` is the id of the newest running turn of the thread in the turn registry, or `null`. The newest turn has the latest start, and the greater turn id breaks a tie.
- `pendingAsks` is the count of the pending asks of the ledger whose thread is that thread.

A route MUST read the pending asks one time for each request, whatever the count of its threads. A failed ask read MUST give 500 `internal_error`. A route that writes MUST read the asks before its write, thus a failed ask read changes nothing.

#### Scenario: A thread with a turn and an ask

- **GIVEN** a thread with a running turn that waits on one open ask
- **WHEN** a client lists the threads of its analysis
- **THEN** the item of the thread has the id of the turn as `runningTurnId` and `pendingAsks` 1

#### Scenario: An idle thread

- **GIVEN** a thread with no running turn and no open ask
- **WHEN** a client reads the thread
- **THEN** it has `runningTurnId` `null` and `pendingAsks` 0

#### Scenario: A failed ask read does not rename

- **GIVEN** a server whose `askGateway.pending()` call rejects
- **WHEN** a client sends `PATCH {T}` with a new title
- **THEN** the server answers 500, and the title of the thread does not change

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

### Requirement: The run list finds the runs by a text

`GET {A}/runs` MUST take the query value `q`. It MUST select the runs whose run id holds the text, and the runs whose plan title holds the text. The match MUST have no regard to case, and each character of `q` MUST match only itself. The plan title is the `title` of the stored plan of the run. Thus a run with no plan, or with a plan that is gone, matches by its run id only. An absent or empty `q` MUST select each run.

`q` MUST narrow the runs that the other query values select:

- With `active=true`, the server selects the running runs that `q` selects. It ignores `threadId`, as it does with no `q`.
- With `threadId` and no `active=true`, the server selects the runs of the thread that `q` selects.
- With neither value, the server selects each run of the analysis that `q` selects.

The filter MUST apply before the page, and the order of the runs MUST stay newest first. With `active=true` or with no `threadId`, `total` MUST count the runs that the filters select. With `threadId` and no `active=true`, `total` is a lower bound. It counts the selected runs up to the end of the page, plus one when a later page has a selected run.

The harness ledger MUST do the filter. The route MUST NOT read a run that `q` does not select, and it MUST NOT filter a page after the read.

#### Scenario: A text finds a run by its title

- **GIVEN** analysis `a1` with run `r1` of the plan titled "Differential expression" and run `r2` of the plan titled "Pathway enrichment"
- **WHEN** a client sends `GET /api/v1/analyses/a1/runs?q=PATHWAY`
- **THEN** the server answers with `r2` only, with its `planTitle`, and `total` is 1

#### Scenario: A text finds a run by a part of its id

- **GIVEN** analysis `a1` with run `5f3a9c` and run `7b21e0`
- **WHEN** a client sends `GET /api/v1/analyses/a1/runs?q=3a9`
- **THEN** the server answers with run `5f3a9c` only

#### Scenario: The text selects the runs before the page

- **GIVEN** analysis `a1` with 150 runs whose plan title holds "volcano", and 300 newer runs whose title does not
- **WHEN** a client sends `GET /api/v1/analyses/a1/runs?q=volcano&perPage=100`
- **THEN** the server answers with the 100 newest runs that match, `total` is 150, and `hasMore` is true

#### Scenario: The text combines with the active runs

- **GIVEN** analysis `a1` with a running run and a completed run whose plan titles hold "volcano"
- **WHEN** a client sends `GET /api/v1/analyses/a1/runs?active=true&q=volcano`
- **THEN** the server answers with the running run only, and `total` is 1

#### Scenario: The active runs take precedence over the thread

- **GIVEN** analysis `a1` with a running run `r1` in thread `t2` whose plan title holds "volcano"
- **WHEN** a client sends `GET /api/v1/analyses/a1/runs?active=true&threadId=t1&q=volcano`
- **THEN** the server answers with `r1`, and `total` is 1

#### Scenario: An empty text selects each run

- **WHEN** a client sends `GET /api/v1/analyses/a1/runs?q=`
- **THEN** the server answers with the same runs and the same `total` as with no `q`

### Requirement: A run summary gives the artifact count of the run

Each run of `GET {A}/runs` and the run of `GET {A}/run/:runId` MUST carry `artifactCount`, the count of the step outputs that the run registered. A run with no step output MUST give 0. This is the count of the run-completed card.

The runs of one page MUST get their counts from one grouped read of the harness, whatever the page size. A failed count read MUST NOT fail the response. Then `artifactCount` MUST be absent on each run of the response, and the failure MUST go to the log.

#### Scenario: The counts of a page of runs

- **GIVEN** run `r1` with 3 step outputs and run `r2` with none
- **WHEN** a client lists the runs of the analysis
- **THEN** `r1` has `artifactCount` 3 and `r2` has `artifactCount` 0
- **AND** the server sends one count read for the page

#### Scenario: A failed count read

- **GIVEN** a count read that fails
- **WHEN** a client lists the runs of the analysis
- **THEN** the server answers 200, and no run has `artifactCount`

### Requirement: The server gives the synthesis of a run

`GET {A}/run/:runId/synthesis` MUST give `{ status, reason, synthesis }`:

- `status` is the synthesis outcome of the run row: `produced`, `skipped_no_summaries`, `skipped_blocker`, `failed`, or `null` when the row records no outcome.
- `reason` is the synthesis reason of the run row, or `null`.
- `synthesis` is the flat `data-run-synthesis` part of the synthesis record of the run, with the references of each finding. It is the part that the run stream carries.

The run row is the authority on whether a synthesis exists. Thus the server MUST read the record only when `status` is `produced`, and `synthesis` MUST be `null` for each other status. When `status` is `produced`, `synthesis` MUST be `null` in these cases, and the server MUST log a warning:

- the workspace folder of the analysis does not resolve, or does not exist
- the record is absent, is not readable, holds more than 1 MiB, or fails the stored synthesis schema

A run of a different analysis, and an id that names no run, MUST get 404 `not_found`. The route needs the harness runtime, thus it MUST answer 503 `unavailable` before the phase is `ready`. A failed read of the run row MUST give 500 `internal_error`.

#### Scenario: A produced synthesis

- **GIVEN** run `r1` whose synthesis outcome is `produced`, with its record on disk
- **WHEN** a client sends `GET /api/v1/analyses/a1/run/r1/synthesis`
- **THEN** the server answers with `status` `produced` and the synthesis part, and each finding has its references

#### Scenario: A skipped synthesis

- **GIVEN** run `r1` whose synthesis outcome is `skipped_blocker` with a reason
- **WHEN** a client reads the synthesis of `r1`
- **THEN** the server answers with `status` `skipped_blocker`, the reason, and `synthesis` `null`

#### Scenario: A record in a folder that is not writable

- **GIVEN** run `r1` whose outcome is `produced`, with its record in a workspace folder that is readable but not writable
- **WHEN** a client reads the synthesis of `r1`
- **THEN** the server answers with the synthesis part

#### Scenario: A produced outcome with no record

- **GIVEN** run `r1` whose outcome is `produced`, and whose record is gone from the disk
- **WHEN** a client reads the synthesis of `r1`
- **THEN** the server answers 200 with `status` `produced` and `synthesis` `null`

#### Scenario: A run of a different analysis

- **WHEN** a client reads the synthesis of a run of analysis `a2` under analysis `a1`
- **THEN** the server answers 404 `not_found`

### Requirement: A run read gives the plan of the run

Each run of `GET {A}/runs` and the run of `GET {A}/run/:runId` MUST carry `planId`. It is the plan id of the run row, or `null` for a run with no plan. The list MUST send no read for this field.

`GET {A}/run/:runId` MUST carry `plan`, as `{ planId, steps }`. `steps` MUST hold one entry for each step of the stored plan, in the order of the plan. Each entry MUST carry these fields:

- `id`, the step id
- `name`, the step name
- `agent`, the agent of the step, or `"unknown"` when the plan names no agent
- `dependsOn`, the step ids that the step depends on
- `level`, the level of the step in the plan graph, as the `data-dag-state` part gives it

`plan` MUST be `null` in these cases:

- the run has no plan
- the plan is gone, or its read failed
- the plan document fails the stored plan schema, or its steps do not form a valid graph

A plan step with no ledger row MUST be in `plan.steps`, and it MUST NOT be in `steps`. Such a step did not start. The server MUST read the stored plan one time for each request. A failed plan read MUST NOT fail the response.

#### Scenario: The plan graph of a finished run

- **GIVEN** run `r1` of plan `p1`, with steps `T1S1` and `T1S2`, where `T1S2` depends on `T1S1`
- **WHEN** a client sends `GET /api/v1/analyses/a1/run/r1`
- **THEN** `planId` is `p1`, and `plan.steps` gives `T1S1` at level 0 and `T1S2` at level 1, each with its agent and its dependencies

#### Scenario: A plan step that did not start

- **GIVEN** run `r1` whose plan has step `T1S2`, and no ledger row of `T1S2`
- **WHEN** a client reads run `r1`
- **THEN** `plan.steps` has `T1S2`, and `steps` does not have it

#### Scenario: A run whose plan is gone

- **GIVEN** run `r1` with plan id `p1`, and no stored plan `p1`
- **WHEN** a client reads run `r1`
- **THEN** the server answers 200, `planId` is `p1`, and `plan` is `null`

#### Scenario: The plan id of each run of a list

- **GIVEN** run `r1` of plan `p1`, and run `r2` with no plan
- **WHEN** a client lists the runs of the analysis
- **THEN** `r1` has `planId` `p1`, and `r2` has `planId` `null`

### Requirement: The server gives one plan with its lineage and its runs

`GET {A}/plans/:planId` MUST give `{ plan, parentPlanId, supersededBy, runIds, hasMoreRuns }`:

- `plan` is the `data-plan` part of the stored plan, with the title of the plan. It is `null` when the plan document does not give a part, and the server MUST then log a warning.
- `parentPlanId` is the id of the plan that this plan revised, or `null`.
- `supersededBy` is the id of the newest plan of the analysis that revised this plan, or `null`.
- `runIds` holds the ids of the runs of the plan, newest first. It holds at most 100 ids.
- `hasMoreRuns` is `true` when the plan has more than 100 runs, else `false`.

The server MUST send at most two harness reads for each request, whatever the count of the runs of the plan.

A plan of a different analysis, and an id that names no plan, MUST get 404 `not_found`. A plan whose document does not give a part is not absent, thus it MUST get 200 with its lineage and its runs. The route needs the harness runtime, thus it MUST answer 503 `unavailable` before the phase is `ready`. A failed read MUST give 500 `internal_error`.

#### Scenario: A revised plan names the newer plan

- **GIVEN** plan `pln-0000000a`, and plan `pln-0000000b` that revised it
- **WHEN** a client sends `GET /api/v1/analyses/a1/plans/pln-0000000a`
- **THEN** `supersededBy` is `pln-0000000b`, and `parentPlanId` is `null`

#### Scenario: The revision names its parent

- **WHEN** a client reads plan `pln-0000000b`
- **THEN** `parentPlanId` is `pln-0000000a`, and the `plan` part has the same `parentPlanId`

#### Scenario: The runs of a plan

- **GIVEN** plan `p1` with runs `r1` and `r2`, where `r2` started later
- **WHEN** a client reads plan `p1`
- **THEN** `runIds` is `r2`, then `r1`

#### Scenario: A plan of a different analysis

- **WHEN** a client reads a plan of analysis `a2` under analysis `a1`
- **THEN** the server answers 404 `not_found`

#### Scenario: A plan whose document does not parse

- **GIVEN** plan `p1` with runs, whose document fails the stored plan schema
- **WHEN** a client reads plan `p1`
- **THEN** the server answers 200, `plan` is `null`, and `runIds` gives the runs of `p1`

#### Scenario: A plan with more runs than the limit

- **GIVEN** plan `p1` with 101 runs
- **WHEN** a client reads plan `p1`
- **THEN** `runIds` holds the 100 newest ids, and `hasMoreRuns` is `true`

### Requirement: The server approves a plan by its id

`POST {A}/plans/:planId/approve` MUST approve the plan through the approval of the harness runtime, with the body `{ threadId, newestRunId }`. The server gives the local identity and the local auth, as the chat turn does. The route MUST NOT call a model.

`newestRunId` is the newest run of the plan that the client saw: the first id of the `runIds` of `GET {A}/plans/:planId`. It is `null` when that list was empty. The server MUST give it to the approval of the harness, which compares it with the newest run of the plan.

The route MUST answer in this order:

1. 503 `draining` while the server stops, before it reads the body.
2. 400 `validation_error` for a body with no non-empty `threadId`, or with a `newestRunId` that is absent, empty, or not a string or `null`.
3. 409 `busy` while a chat turn of the registry runs on the thread. The details carry `reasons: ["chat_turn"]`.
4. The outcome of the approval, below.

A success MUST answer 201 with `{ planId, runId, started, message }`. `started: false` means that the approval started no run. Then a run of the plan is active, or the newest run of the plan is not `newestRunId`, and `runId` names that run. The approval then records nothing, and `message` is `null`. Otherwise `message` is the record of the approval, with the shape of a message of `GET {T}/messages` and with no creation time. A success that started the run MUST note the activity of the analysis.

A refusal MUST answer as follows:

- 404 `not_found` for an unknown thread, an archived thread, or a thread of a different analysis
- 404 `not_found` for an unknown plan, or a plan of a different analysis
- 404 `not_found` for a `newestRunId` that is not `null` when the plan has no run
- 409 `conflict` with `details.reason` for each other refusal: `superseded`, `plan_invalid`, `packages_missing`, `not_authorized`, and `suspended`
- 500 `internal_error` for a failed store read or write, and for a failed start of the workflow

A `superseded` refusal MUST carry `details.supersededBy`, the id of the newest plan that revised the plan. A `plan_invalid` refusal carries `details.errors`. A `packages_missing` refusal carries `details.missing` and `details.collisions`, and `details.unavailable` when the store cannot answer.

The route needs the harness runtime, thus it MUST answer 503 `unavailable` before the phase is `ready`.

#### Scenario: A click on Approve starts the run

- **GIVEN** plan `pln-0000000a` of analysis `a1`, a live thread `t1`, and no run of the plan
- **WHEN** a client sends `POST /api/v1/analyses/a1/plans/pln-0000000a/approve` with `{ "threadId": "t1", "newestRunId": null }`
- **THEN** the server answers 201 with the plan id, a new run id, `started: true`, and the record message

#### Scenario: A second click names the active run

- **GIVEN** plan `pln-0000000a` with the active run `r1`
- **WHEN** a client approves `pln-0000000a` with the `newestRunId` `r1`
- **THEN** the server answers 201 with the run id `r1`, `started: false`, and `message: null`

#### Scenario: A stale view names the newest run

- **GIVEN** plan `pln-0000000a` with the run `r1`, which ended
- **WHEN** a client approves `pln-0000000a` with the `newestRunId` `null`
- **THEN** the server answers 201 with the run id `r1`, `started: false`, and `message: null`, and no run starts

#### Scenario: A view of the newest run runs the plan again

- **GIVEN** plan `pln-0000000a` with the run `r1`, which ended
- **WHEN** a client approves `pln-0000000a` with the `newestRunId` `r1`
- **THEN** the server answers 201 with a new run id, `started: true`, and the record message

#### Scenario: A view of a run that the plan does not have is not found

- **GIVEN** plan `pln-0000000a` with no run
- **WHEN** a client approves `pln-0000000a` with the `newestRunId` `r9`
- **THEN** the server answers 404 `not_found`, and no run starts

#### Scenario: A body with no newest run id is refused

- **WHEN** a client approves a plan with the body `{ "threadId": "t1" }`
- **THEN** the server answers 400 `validation_error`, and no run starts

#### Scenario: A replaced plan is a conflict

- **GIVEN** plan `pln-0000000a`, and plan `pln-0000000b` that revised it
- **WHEN** a client approves `pln-0000000a`
- **THEN** the server answers 409 `conflict` with `details.reason` `superseded` and `details.supersededBy` `pln-0000000b`

#### Scenario: A running turn holds the thread

- **GIVEN** a chat turn that runs on thread `t1`
- **WHEN** a client approves a plan on `t1`
- **THEN** the server answers 409 `busy`, and no run starts

#### Scenario: An unknown thread is not found

- **WHEN** a client approves a plan on a thread id that analysis `a1` does not hold
- **THEN** the server answers 404 `not_found`

#### Scenario: A stop refuses an approval

- **GIVEN** a server that stops
- **WHEN** a client approves a plan
- **THEN** the server answers 503 `draining`, and no run starts

### Requirement: The transcript read gives one page of turns

`GET {T}/messages` MUST give one page of the transcript of the thread. A page holds whole turns, and the pages go from the newest turn to the oldest turn.

The read MUST take these query values:

- `limit`: the maximum count of turns in the page. The default is 20, and the maximum is 100. A value that is absent, or that is not a positive integer, MUST give 20, and it MUST NOT give a 400. A larger value MUST give 100.
- `before`: the cursor that an earlier page of the same thread gave. With no `before`, the read MUST give the newest page. A value that is not a decimal integer from 0 to the largest safe integer MUST give 400 `validation_error`. An empty value is such a value.

The response MUST be `{messages, total, page, perPage, hasMore, before}`:

- `messages` holds the messages of the turns of the page, in chat order: the oldest turn first.
- `before` is the cursor of the next older page, as a string. It is `null` when the page holds the start of the session.
- `total` is the count of the turns of the page, and `page` is 0.
- `perPage` is the limit that the server applied.
- `hasMore` is true when `before` is not `null`.

A cursor is opaque. A client sends back the `before` of a page, and it does not make a cursor.

The server MUST read from the store only the turns of the page. Thus a request costs about the same for a long thread and for a short thread. A thread with no live row MUST give 404 `not_found`. A failed read of the store MUST give 500 `internal_error`.

#### Scenario: A read with no cursor gives the newest turns

- **GIVEN** a thread of 30 turns
- **WHEN** a client sends `GET {T}/messages`
- **THEN** the messages are the messages of the newest 20 turns, in chat order
- **AND** `total` is 20, `perPage` is 20, `hasMore` is true, and `before` is not `null`

#### Scenario: The cursor of a page gives the turns before it

- **GIVEN** a thread of 30 turns, and the `before` of its newest page of 20 turns
- **WHEN** a client sends `GET {T}/messages?before=<that cursor>`
- **THEN** the messages are the messages of the oldest 10 turns, in chat order
- **AND** `total` is 10, `hasMore` is false, and `before` is `null`

#### Scenario: A short thread fits in one page

- **GIVEN** a thread of 3 turns
- **WHEN** a client sends `GET {T}/messages`
- **THEN** the messages are the messages of the 3 turns, `hasMore` is false, and `before` is `null`

#### Scenario: The limit has a maximum and a default

- **WHEN** a client sends `GET {T}/messages?limit=500`, and then `GET {T}/messages?limit=abc`
- **THEN** the first response has `perPage` 100, and the second response has `perPage` 20

#### Scenario: A bad cursor is refused

- **WHEN** a client sends `GET {T}/messages?before=abc`
- **THEN** the server answers 400 with the error `validation_error`, and it reads no turn

#### Scenario: The server reads only the turns of the page

- **GIVEN** a thread of 500 turns
- **WHEN** a client sends `GET {T}/messages?limit=20`
- **THEN** the server reads the 20 newest turns from the store, and no other turn

#### Scenario: A thread with no row

- **WHEN** a client sends `GET {T}/messages` for a thread that has no live row
- **THEN** the server answers 404 with the error `not_found`
