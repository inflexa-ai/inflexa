## MODIFIED Requirements

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
