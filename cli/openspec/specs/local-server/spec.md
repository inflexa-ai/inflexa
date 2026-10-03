# local-server Specification

## Purpose

The local server of the CLI: one process for each OS user and each build channel that holds the harness runtime and the local stores. This spec gives its lifecycle (the bind, the discovery file, the start by a client, the stop), the `server` commands, the import rule of a client, and the conventions of its HTTP API. The TUI, the instance commands, and a later GUI are its clients.

## Requirements

### Requirement: One local server holds the runtime and the local stores

Each OS user MUST have one server process for each build channel. That process MUST hold the harness runtime, the SQLite database, the provenance recorder, and the package store work. The TUI, each `instance` command, and a later GUI MUST be clients of its HTTP API under `/api/v1`. A client MUST NOT boot the harness runtime, and it MUST NOT open the SQLite database. The one exception is the dev `run --plan`, which boots its own runtime. The runtime lock refuses it while a server runs.

The server MUST give no guarantee that the harness and Cortex do not give together. Thus it adds a coordination item only when the harness does not enforce it and a client breaks without it.

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

### Requirement: Each API request carries the bearer token

At its start, the server MUST make a random 256-bit token, and it MUST write the token only to the discovery file. Each request to a path under `/api/` MUST send `Authorization: Bearer <token>`. A missing or different token MUST get 401 `unauthorized`. The server MUST compare the token in constant time. The token proves that the caller is a process of the OS user that can read the file. One server serves one OS user, thus each client acts as that user: the ask grants MUST use the one user id `local`, and each client can answer each pending ask.

#### Scenario: A request with no token

- **WHEN** a request to `GET /api/v1/projects` sends no `Authorization` header
- **THEN** the server answers 401 with the error `unauthorized`

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
| `internal_error` | 500 |
| `unavailable`, `draining` | 503 |

A `validation_error` MUST carry the zod flatten output in `details`. A 500 MUST carry a generic message, and the cause MUST go only to the log. An unknown path MUST get 404 `not_found`.

Each list MUST take the query values `page` (zero-based, default 0) and `perPage` (default 100, cap 200). A bad value MUST fall back to the default, and it MUST NOT give a 400. The response MUST be `{<resource>: T[], total, page, perPage, hasMore}`, where the key names the resource.

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
- the records of `{A}`: the usage, the provenance, and the artifacts
- the package store: the state, the transfers, and the failed flights (retry and delete)

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

### Requirement: An analysis route checks the analysis and its instance lock

Each route under `/api/v1/analyses/:analysisId` MUST answer 404 `not_found` when no analysis has the id. At the first request for an analysis, the server MUST take the instance lock of that analysis. It MUST hold the lock until it exits. A lock that a different live process holds MUST give 409 `locked` with `details.holderPid`. The lock keeps one provenance recorder on each signed chain across processes, as a fence against an installed binary from before the server.

#### Scenario: An analysis that a different process holds

- **GIVEN** a different live process that holds the instance lock of analysis `a1`
- **WHEN** a client sends `GET /api/v1/analyses/a1`
- **THEN** the server answers 409 `locked` with the pid of the holder

### Requirement: The chat turn and the run stream use SSE

The server MUST use SSE only for the chat turn and for the run stream. Each frame MUST be `data: <JSON>` and a blank line, with no `event:` field and no `id:` field. The stream MUST send the comment `: open` at once, so that the headers go out before the first frame. It MUST send the comment `: ping` each 5 s, because `Bun.serve` closes a connection that is silent for 10 s. No `Last-Event-ID` resume exists: a chat client that connects again reads the transcript, and a run client gets a full replay.

The run stream MUST deliver the parts of the harness run-event reader, and it MUST close after the terminal part, also for a canceled run. A run of a different analysis MUST get 404 `not_found`. The stream of a data profile workflow MUST close when that workflow ends.

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

One query MUST count the live durable work, for one analysis or for each analysis. The busy gate and the activity of a stop MUST both read it. A workflow is live when its status is `PENDING`, `ENQUEUED`, or `DELAYED`. A run counts when its ledger status is `running` or `suspended_insufficient_funds`, and a live workflow stands behind it. That workflow is the run, or one of its `<runId>-N` children. A crashed host leaves a `running` row for ever, thus the status of the workflow is the record of liveness.

#### Scenario: A rename during a run

- **GIVEN** an analysis with a run whose workflow is live
- **WHEN** a client renames the analysis
- **THEN** the server answers 409 `busy` with the reason `run`

#### Scenario: A stale run row does not block

- **GIVEN** an analysis with a `running` run row whose workflow is terminal
- **WHEN** a client renames the analysis
- **THEN** the server does not give the reason `run`

### Requirement: Polls take the place of the bus

The server MUST NOT give a notification stream. The bus MUST stay inside the server process. Each client MUST read an endpoint again at its own edges and on its own schedule. Each push that a client must see MUST be state that an endpoint returns.

The TUI MUST keep one poll interval while an analysis is open. The interval is 5 s while work is active or a turn of a different client runs on the open thread, and 15 s otherwise. Each tick MUST do these reads:

- the runs and the data profile of the analysis, per `sidebar-live`
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

The `Host` header of each request MUST be `127.0.0.1:<port>` or `localhost:<port>`, where the port is the port that the server bound. Otherwise the server MUST answer 403 `forbidden`. An `Origin` header MUST be `http://` with one of the two, or absent. The check MUST run on each path, before the bearer check. A web page whose host name points at 127.0.0.1 still sends its own host name, and a page cannot change the two headers. Thus the check stops a DNS rebind.

A request that no socket carried, an `app.request()` call of a test, MUST pass the check.

#### Scenario: A rebound host name

- **WHEN** a request to the server sends the `Host` header `evil.example:8436`
- **THEN** the server answers 403 `forbidden`, and no route runs

#### Scenario: A page of a different origin

- **WHEN** a request sends the correct `Host` header and the `Origin` header `http://evil.example`
- **THEN** the server answers 403 `forbidden`

### Requirement: The dev channel serves a web page of the API

A server of the dev channel MUST serve one static web page at `/gui/`, and it MUST redirect `/gui` there. A production server MUST NOT serve the page. The page is a client of the API, as the TUI is: it lists the analyses, their runs, their threads, and the messages of a thread, and it sends a chat turn. The page holds no secret, thus it needs no bearer token. It MUST read the token from the fragment of its URL (`/gui/#token=<token>`), and send the token on each API call. A browser never sends the fragment to the server.

`bun scripts/poc_gui.ts` MUST print the URL of the page from the discovery file of the dev channel, with the token in the fragment. With `--open`, it MUST also open the URL in the default browser. With no discovery file, it MUST fail and name `bun run dev serve`.

#### Scenario: The page of a dev server

- **GIVEN** a server of the dev channel
- **WHEN** a browser opens the URL that `bun scripts/poc_gui.ts` prints
- **THEN** the page loads, and it lists the analyses through the API with the token of the fragment

#### Scenario: A production server serves no page

- **WHEN** a client requests `/gui/` from a production server
- **THEN** the server answers 404 `not_found`

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
- A recorded failure of the farm composition MUST refuse with its reason. The read consumes the record, thus the next drive composes again.

The engine and the filesystem decide usability, and a transfer row gives only the reason of a refusal. A refused re-profile MUST give 409 `conflict` with the line. A refused chat open MUST give the outcome `failed` with the line, and start no drive. A refused input change MUST wait, per the coordination requirement.

#### Scenario: A re-profile with no sandbox image

- **GIVEN** an analysis with inputs, and no sandbox image in the engine
- **WHEN** a client sends `POST {A}/data-profile/rerun`
- **THEN** the server answers 409 `conflict` with the line that names `inflexa sandbox pull`, and nothing is staged

#### Scenario: A chat open during a transfer

- **GIVEN** a live catalog transfer
- **WHEN** a client sends `GET {A}/chat-context` for an analysis with inputs
- **THEN** the profile outcome is `failed` with the transfer line, and no drive starts
