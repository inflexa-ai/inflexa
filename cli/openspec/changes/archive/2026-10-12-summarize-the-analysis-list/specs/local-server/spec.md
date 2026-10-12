# Spec Delta

## ADDED Requirements

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
