# Spec Delta

## ADDED Requirements

### Requirement: The attention read gives the work that waits for the person

`GET /api/v1/attention` MUST give four lists over each analysis: `asks`, `activeRuns`, `unseenRuns`, and `recentThreads`. The route reads Postgres, thus it MUST answer 503 `unavailable` until the phase is `ready`.

The lists MUST hold these items:

- `asks`: each pending ask of the ledger, the oldest first. An item carries `askId`, `analysisId`, `analysisName`, `threadId`, `title`, `command`, `createdAt`, and `stale`. `stale` is `true` when no turn of the turn registry runs on the thread of the ask. An ask with no thread is stale.
- `activeRuns`: each run with a live workflow, by the liveness rule of the busy gate, the newest start first. An item carries `runId`, `analysisId`, `analysisName`, `threadId`, `planTitle`, `doneSteps`, `totalSteps`, and `startedAt`. `planTitle` and `threadId` are `null` when the run has none. A run whose progress read gives a terminal status ended between the two reads, and the list MUST leave it out.
- `unseenRuns`: each terminal run that ended at or after the seen baseline and that has no seen mark, the newest end first. An item carries `runId`, `analysisId`, `analysisName`, `status`, and `completedAt`.
- `recentThreads`: the newest live conversation threads, the newest update first. An item carries the fields of a thread on the wire and `analysisName`.

`activeRuns` and `unseenRuns` MUST each hold at most 200 items. The `limit` query value sets the count of `recentThreads`. A value that is not a positive integer selects 10. A value above 200 selects 200.

Each item MUST name an analysis that has a SQLite row, and `analysisName` is the name of that row. The read MUST leave out an item whose analysis has no row, because no `{A}` route can open it. When the seen baseline is absent, `unseenRuns` MUST be empty.

The count of the reads of one request MUST NOT depend on the count of analyses or of items. The Postgres reads are these:

- one `askGateway.pending()` call
- one read of the live runs
- one progress read of those runs, and none when no run is live
- one read of the runs that ended at or after the seen baseline, and none when the seen baseline is absent
- one read of the newest threads

The SQLite reads are the read of the seen state and the read of the names of the analyses. Each sends a fixed count of statements. A failed read MUST give 500 `internal_error`, and the failure MUST go to the log.

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

## MODIFIED Requirements

### Requirement: The routes group by domain and keep the Cortex path tail

The routes MUST be under `/api/v1`, in these groups:

- the server: its state, a new boot, the activity, and the stop
- the machine: the account, the agents and their models, the models of the connection, the settings, and the embedding models
- the projects, the anchors (repair, relocate, prune), and the analyses (resolve, list, make)
- the attention read (`/api/v1/attention`): the work that waits for the person, over each analysis
- one analysis `{A}` (`/api/v1/analyses/:analysisId`): the analysis itself, its output folder, and its inputs
- the conversation of `{A}`: the threads, the chat, the turns, and the asks
- the runs of `{A}`: the runs, one run, its stream, its cancel, and its seen mark
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
