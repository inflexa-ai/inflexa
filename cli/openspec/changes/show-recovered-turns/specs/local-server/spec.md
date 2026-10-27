## MODIFIED Requirements

### Requirement: A thread on the wire carries its running turn and its open asks

Each thread that a route gives MUST carry `runningTurnId` and `pendingAsks`. The routes are `GET {A}/threads`, `GET {T}`, `PATCH {T}`, `POST {T}/restore`, and the items of `recentThreads` of the attention read.

- `runningTurnId` is the id of the newest running turn of the thread in the turn registry. Else it is the turn that holds the thread while its durable workflow is live, or `null`. The newest turn has the latest start, and the greater turn id breaks a tie.
- `pendingAsks` is the count of the pending asks of the ledger whose thread is that thread.

A route MUST read the pending asks one time and the live turns one time for each request, whatever the count of its threads. A failed ask read or turn read MUST give 500 `internal_error`. A route that writes MUST read the asks and the live turns before its write, thus a failed read changes nothing.

#### Scenario: A thread with a turn and an ask

- **GIVEN** a thread with a running turn that waits on one open ask
- **WHEN** a client lists the threads of its analysis
- **THEN** the item of the thread has the id of the turn as `runningTurnId` and `pendingAsks` 1

#### Scenario: A thread whose turn a recovery runs

- **GIVEN** a thread that a turn holds, and the turn registry does not hold the turn, because a recovery runs it after a restart of the server
- **WHEN** a client reads the thread
- **THEN** it has the id of that turn as `runningTurnId`

#### Scenario: An idle thread

- **GIVEN** a thread with no running turn and no open ask
- **WHEN** a client reads the thread
- **THEN** it has `runningTurnId` `null` and `pendingAsks` 0

#### Scenario: A failed ask read does not rename

- **GIVEN** a server whose `askGateway.pending()` call rejects
- **WHEN** a client sends `PATCH {T}` with a new title
- **THEN** the server answers 500, and the title of the thread does not change

### Requirement: The attention read gives the work that waits for the person

`GET /api/v1/attention` MUST give four lists over each analysis: `asks`, `activeRuns`, `unseenRuns`, and `recentThreads`. The route reads Postgres, thus it MUST answer 503 `unavailable` until the phase is `ready`.

The lists MUST hold these items:

- `asks`: each pending ask of the ledger, the oldest first. An item carries `askId`, `analysisId`, `analysisName`, `threadId`, `title`, `command`, `createdAt`, and `stale`. `stale` is `true` when no turn runs on the thread of the ask, by the rule of the running turn of a thread. An ask with no thread is stale.
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
- one read of the live turns of the threads of the asks and of the newest threads

The SQLite reads are the read of the seen baseline, the read of the seen marks of the ended runs of that read, and the read of the names of the analyses. Each sends a fixed count of statements. The count of the seen marks MUST NOT change the size of a read. A failed read MUST give 500 `internal_error`, and the failure MUST go to the log.

#### Scenario: An ask and a run of two analyses

- **GIVEN** an open ask in analysis `a1` and a run with a live workflow in analysis `a2`
- **WHEN** a client sends `GET /api/v1/attention`
- **THEN** `asks` holds the ask with the name of `a1`, and `activeRuns` holds the run with the name of `a2`

#### Scenario: An ask with no turn is stale

- **GIVEN** an open ask whose thread has no running turn, for example after the server started again
- **WHEN** a client reads the attention lists
- **THEN** the item of the ask has `stale` `true`

#### Scenario: An ask on a thread whose turn a recovery runs

- **GIVEN** an open ask whose thread is held by a turn that a recovery runs after a restart of the server
- **WHEN** a client reads the attention lists
- **THEN** the item of the ask has `stale` `false`

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
