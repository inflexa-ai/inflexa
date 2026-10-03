## MODIFIED Requirements

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

A route that can work for longer than 10 s before its response MUST lift the idle timeout of the connection for that request.

#### Scenario: A thread route keeps the Cortex tail

- **WHEN** a client lists the threads of analysis `a1`
- **THEN** the path is `/api/v1/analyses/a1/threads`, the Cortex tail with no organization segment

#### Scenario: The server gives no reclaim route

- **WHEN** a client sends `POST /api/v1/store/reclaim`
- **THEN** the server answers 404 `not_found`

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

## ADDED Requirements

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
