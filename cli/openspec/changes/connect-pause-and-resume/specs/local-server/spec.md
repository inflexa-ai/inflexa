## ADDED Requirements

### Requirement: A rename or a delete waits for no live work

A rename of an analysis and a delete of an analysis move or remove its workspace folder. The server MUST refuse them with 409 `busy` while work can hold that folder, and `details.reasons` MUST name the work:

- `chat_turn`: a chat turn of the analysis runs, or waits in a pause
- `data_profile`: a profile drive is queued or runs, or the profile ledger row is `running`
- `run`: an active run has a live workflow
- `profile_state_unreadable` or `run_state_unreadable`: a ledger read failed

An unreadable state MUST read as busy. With no runtime, only the turn and the profile drive can hold the folder.

One query MUST count the live durable work, for one analysis or for each analysis. The busy gate and the activity of a stop MUST both read it. A workflow is live when its status is `PENDING`, `ENQUEUED`, or `DELAYED`. A run counts when its ledger status is `running`, and a live workflow stands behind it. That workflow is the run, or one of its `<runId>-N` children. A crashed host leaves a `running` row for ever, thus the status of the workflow is the record of liveness. A run with a paused step has a live workflow, thus it counts.

#### Scenario: A rename during a run

- **GIVEN** an analysis with a run whose workflow is live
- **WHEN** a client renames the analysis
- **THEN** the server answers 409 `busy` with the reason `run`

#### Scenario: A stale run row does not block

- **GIVEN** an analysis with a `running` run row whose workflow is terminal
- **WHEN** a client renames the analysis
- **THEN** the server does not give the reason `run`

#### Scenario: A paused run blocks

- **GIVEN** an analysis with a run whose step waits in `paused`
- **WHEN** a client renames the analysis
- **THEN** the server answers 409 `busy` with the reason `run`

### Requirement: The server lists and resumes paused work

`GET {A}/paused-work` MUST give the paused work of the analysis from `pausedWork.list` of the harness. Each item MUST carry the work id, the kind, and the thread of a turn. It MUST carry each waiting workflow with its state, its cause, its attempt, and its next retry. For the cause `credential`, the item MUST carry the remedy that the server knows for a failed turn.

`POST {A}/paused-work/:workId/resume` MUST resume the work through `pausedWork.resume`, with the session of the server. It MUST give 200 with the count of the resumed workflows. It MUST give 404 when the analysis has no such paused work. With no runtime, the two routes give 503.

The stop of paused work MUST use the existing routes: the abort of a turn, and the cancel of a run.

#### Scenario: A client resumes a paused run

- **GIVEN** a run of the analysis whose step waits in `paused`
- **WHEN** a client sends `POST {A}/paused-work/:workId/resume` with the run id
- **THEN** the server gives 200 with one workflow, and the step sends its request again

#### Scenario: A credential pause carries its remedy

- **GIVEN** a turn that waits in `paused` with the cause `credential`, and a provider login that is dead
- **WHEN** a client sends `GET {A}/paused-work`
- **THEN** the item of the turn carries the remedy to sign in again

#### Scenario: An unknown work id

- **WHEN** a client sends `POST {A}/paused-work/:workId/resume` with an id that no paused work has
- **THEN** the server gives 404

## MODIFIED Requirements

### Requirement: The chat turn runs apart from its request

`POST {A}/chat` with `{threadId, message}` MUST open one turn through the chat turns of the harness. The harness runs the turn as a workflow, and it makes the id of the turn. The server MUST register the turn when it opens, and send the id in the response header `Inflexa-Turn-Id`. A stop of the server MUST also wait for a turn that still opens.

A refusal before the turn opens MUST be a JSON error:

- 404 for a thread that is absent or of a different analysis
- 409 `conflict` for a thread whose turn still runs
- 500 for a turn that cannot prepare or has no agent

After the open, the stream MUST carry the frames of the turn and of its sub-agents. It MUST end with one `finish` frame for a turn that ended or aborted. It MUST end with one `error` frame for a turn that failed, with the remedy that the server knows.

A client that disconnects MUST stop only the delivery of the frames, never the turn. `GET {T}/turns/:turnId/stream` MUST give the frames of a turn of the thread again, from the start of the turn. This includes a turn that a recovery runs and the registry does not hold. The stream of a paused turn MUST carry its `data-pause` frames, and it MUST stay open while the turn waits. `POST {T}/turns/:turnId/abort` MUST stop the turn for each client. `GET {T}/turns` and `GET {T}/turns/:turnId` MUST give the running turns and the newest 100 ended turns. Each one has the status, the usage, and the failure detail. The answer of an ask MUST reach the turn that waits for it, through the chat turns of the harness.

At the end of each turn, the server MUST start the flush of the package adds that the turn queued.

#### Scenario: A second client aborts a turn

- **GIVEN** a turn that a TUI started
- **WHEN** a different client sends the abort of its turn id
- **THEN** the turn ends as aborted, and the TUI gets its `finish` frame

#### Scenario: A client leaves during a turn

- **WHEN** the client of a turn closes its connection
- **THEN** the turn runs to its end, and `GET {T}/turns/:turnId` gives its outcome

#### Scenario: A second turn on a thread with a turn that runs

- **GIVEN** a turn that runs on a thread
- **WHEN** a client sends a message to the same thread
- **THEN** the server gives 409 `conflict`, and it starts no turn

#### Scenario: A client reads a turn again

- **GIVEN** a turn that the registry holds
- **WHEN** a client sends `GET {T}/turns/:turnId/stream`
- **THEN** it gets each frame of the turn from its start, and a turn of a different thread gives 404

#### Scenario: A client reads a paused turn after a restart

- **GIVEN** a turn that waits in `paused`, and a server that started again
- **WHEN** a client sends `GET {T}/turns/:turnId/stream`
- **THEN** it gets each frame of the turn from its start, with the last `data-pause` frame
- **AND** the stream stays open while the turn waits

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
- the paused work of the analysis, `GET {A}/paused-work`, per `tui-harness-chat`

Thus an idle TUI sees the work of a different client at most 15 s late.

#### Scenario: A run that a different client started

- **GIVEN** a TUI that is idle on an analysis
- **WHEN** a run of the analysis starts from a different client
- **THEN** the TUI shows the run at its next tick, at most 15 s later

#### Scenario: A server that does not answer gets no more reads

- **GIVEN** a TUI whose server stopped
- **WHEN** the poll ticks
- **THEN** the TUI sends the probe, and it sends no read of the analysis, the usage, or the thread

## REMOVED Requirements

### Requirement: A rename or a delete waits for no work

**Reason**: Its scenario of a suspended run describes a status that no longer exists. A MODIFIED block cannot drop a scenario, thus the requirement "A rename or a delete waits for no live work" replaces it.

**Migration**: Refer to "A rename or a delete waits for no live work" in this capability.
