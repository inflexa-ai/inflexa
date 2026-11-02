## ADDED Requirements

### Requirement: The server lists the paused work of each analysis

`GET /api/v1/paused-work` MUST give the paused work of each analysis from one `work.list` call of the harness with no analysis id. An item MUST have the shape of an item of `GET {A}/paused-work`, with the same remedy rule. Each item MUST carry the analysis id of its work. The body MUST have the list shape with the key `pausedWork`, and the route MUST take `page` and `perPage` by the list rule.

The route MUST leave out the work of an analysis that has no SQLite row, because no `{A}` route can resume or stop that work. The count of the reads of one request MUST NOT depend on the count of analyses or of work. The store reads are the one `work.list` call and at most one SQLite read of the analysis rows.

The route reads Postgres, thus it MUST answer 503 `unavailable` until the phase is `ready`. A failed read MUST give 500 `internal_error`, and the failure MUST go to the log. The route is not under `/api/v1/analyses/:analysisId`, thus it takes no instance lock.

#### Scenario: The paused work of two analyses

- **GIVEN** a turn of the analysis `a1` that waits in `paused`, and a run of the analysis `a2` whose step `s1` waits in `paused`
- **WHEN** a client sends `GET /api/v1/paused-work`
- **THEN** the server calls `work.list` one time with no analysis id
- **AND** `pausedWork` holds the turn with the analysis id `a1` and the run with the analysis id `a2`, and `total` is 2
- **AND** the waiting workflow of the run has the waiter `{ kind: "step", stepId: "s1" }`

#### Scenario: No paused work

- **GIVEN** no work that waits in any analysis, and a run of the analysis `a1` that runs
- **WHEN** a client sends `GET /api/v1/paused-work`
- **THEN** the server answers 200 with `{pausedWork: [], total: 0, page: 0, perPage: 100, hasMore: false}`

#### Scenario: The paused work of an analysis with no row

- **GIVEN** a run that waits in `paused` in an analysis id that has no SQLite row
- **WHEN** a client sends `GET /api/v1/paused-work`
- **THEN** `pausedWork` does not hold the run

#### Scenario: The list during the boot

- **GIVEN** a server whose phase is `starting`
- **WHEN** a client sends `GET /api/v1/paused-work`
- **THEN** the server answers 503 `unavailable`

## MODIFIED Requirements

### Requirement: The routes group by domain and keep the Cortex path tail

The routes MUST be under `/api/v1`, in these groups:

- the server: its state, a new boot, the activity, and the stop
- the machine: the account, the agents and their models, the models of the connection, the settings, and the embedding models
- the desktop of the machine (`/api/v1/sandbox` and `/api/v1/open-directory`): the sandbox readiness of the machine, and the folder open
- the projects, the anchors (repair, relocate, prune), and the analyses (resolve, list, make)
- the attention read (`/api/v1/attention`): the work that waits for the person, over each analysis
- the paused work (`/api/v1/paused-work`): the paused work of each analysis
- one analysis `{A}` (`/api/v1/analyses/:analysisId`): the analysis itself, its output folder, and its inputs
- the conversation of `{A}`: the threads, the chat, the turns, the asks, and the access of a report-session page
- the runs of `{A}`: the runs, one run, its stream, its synthesis, its cancel, its seen mark, the plans, one plan, and its approval
- the profile of `{A}`: the chat context, the data profile, the sandbox readiness, and the farm heal and link
- the records of `{A}`: the usage, the provenance, and the artifacts
- the package store: the state, the transfers, and the failed flights (retry and delete)
- the browser sign-in (`/api/v1/session`): the nonce and the sign-in link
- the file system (`/api/v1/fs`): the home folder, the list of a folder, the bytes of a file, and the preview of a file or a folder
- the picker of the file system (`/api/v1/fs`): the pins, the recent files, and the places of the sidebar

These routes MUST be in the file system group: each folder list, each read of the bytes of a file, each preview, and each search of the file system. A route of a different group can read the disk for its own work, for example `POST {A}/artifacts/resolve`. No route under `/api/v1/analyses/:analysisId` gives the bytes of a file.

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

#### Scenario: The picker routes are in the file system group

- **WHEN** a client reads the pins, the recent files, or the places of the picker
- **THEN** the paths are `/api/v1/fs/pins`, `/api/v1/fs/recents`, and `/api/v1/fs/places`

### Requirement: The server lists and resumes paused work

`GET {A}/paused-work` MUST give the paused work of the analysis from `work.list` of the harness, with the analysis id. Each item MUST carry the work id, the kind, the analysis id, and the thread of a turn. It MUST carry each waiting workflow with its waiter, its state, its cause, its attempt, its next retry, and the start of the wait. For the cause `credential`, the item MUST carry the remedy that the server knows for a failed turn.

The waiter names what waits: the turn, a sub-agent with its agent id, a step with its step id, the synthesis, the run at its charge gate, or the profile. A wait that started before the harness recorded the waiter has no waiter, and its waiting workflow MUST then omit the waiter.

`POST {A}/paused-work/:workId/resume` MUST resume the work through `work.resume`, with the session of the server. It MUST give 200 with the count of the resumed workflows. It MUST give 404 when the analysis has no such paused work. With no runtime, the two routes give 503.

The stop of paused work MUST use the existing routes: the abort of a turn, and the cancel of a run.

#### Scenario: A client resumes a paused run

- **GIVEN** a run of the analysis whose step waits in `paused`
- **WHEN** a client sends `POST {A}/paused-work/:workId/resume` with the run id
- **THEN** the server gives 200 with one workflow, and the step sends its request again

#### Scenario: A credential pause carries its remedy

- **GIVEN** a turn that waits in `paused` with the cause `credential`, and a provider login that is dead
- **WHEN** a client sends `GET {A}/paused-work`
- **THEN** the item of the turn carries the remedy to sign in again

#### Scenario: Two waiting steps name their steps

- **GIVEN** a run of the analysis whose steps `s1` and `s2` wait in `paused`
- **WHEN** a client sends `GET {A}/paused-work`
- **THEN** the item of the run holds two waiting workflows, with the waiters `{ kind: "step", stepId: "s1" }` and `{ kind: "step", stepId: "s2" }`, and each has the start of its wait

#### Scenario: A wait from before the upgrade has no waiter

- **GIVEN** a run of the analysis whose waiting workflow has no waiter in the harness
- **WHEN** a client sends `GET {A}/paused-work`
- **THEN** the waiting workflow of the run has no waiter, and the item stays in the list

#### Scenario: An unknown work id

- **WHEN** a client sends `POST {A}/paused-work/:workId/resume` with an id that no paused work has
- **THEN** the server gives 404

### Requirement: The server holds paused work

`POST {A}/paused-work/:workId/hold` MUST hold the work through `work.hold`, with the session of the server. It MUST give 200 with the count of the waits in `retrying` that the hold moved to `paused`. It MUST give 404 when the analysis has no such paused work, and 503 with no runtime.

#### Scenario: A hold of a run that waits to retry

- **GIVEN** a run with one wait in `retrying` and one wait in `paused`
- **WHEN** a client sends `POST {A}/paused-work/:workId/hold` with the run id
- **THEN** the server answers 200 with the count 1
