## RENAMED Requirements

- FROM: `### Requirement: A host lists and resumes paused work`
- TO: `### Requirement: A host lists the active work, and resumes paused work`

## MODIFIED Requirements

### Requirement: A host lists the active work, and resumes paused work

The runtime MUST give `CoreRuntime.work`, of the type `WorkSurface`, with `list(analysisId)`, `stop(session, workId)`, `resume(session, workId)`, and `hold(session, workId)`. A work is a chat turn, a run, or a data profile. `WorkKind` gives its kind, and `Work` is one item of the list.

`list` MUST give each active work of the analysis, one item for each work id. Each item MUST hold each active waiting workflow of the work in `waiting`. For a work that runs and does not wait, `waiting` MUST be empty. A workflow is active when its DBOS status is `PENDING` or `ENQUEUED`. `list` MUST find the work as follows:

- A turn: the turn that holds a thread of the analysis, only when the workflow of the turn is active. A claim of a thread can stay after its turn ends.
- A run: each run of the analysis whose row is `running`. The run canceler also closes a row whose workflow ended.
- A data profile: the profile whose row is `running`, only when the workflow that `data_profile_workflow_id` names is active.
- The work of each active waiting workflow of the analysis.

`list` MUST skip and delete a row of a pause whose workflow is no longer active.

`resume` MUST send one message to the topic of each waiting workflow of the work. The send MUST carry an idempotency key from the id of the pause. Thus a message never ends a later pause, and a second resume of the same pause sends nothing new. For a turn, `resume` MUST first put the credential of the session for the turn. Work of a different analysis than the session MUST give `not_found`.

A resume in `retrying` MUST end the wait at once. Thus one call gives "retry now" and "resume".

#### Scenario: A resume ends each wait of a run

- **GIVEN** a run whose two sandbox steps wait in `paused`
- **WHEN** a host calls `resume` with the run id
- **THEN** the result is `resumed` with two workflows, and each step sends its request again

#### Scenario: A second resume does no harm

- **GIVEN** a step that waits in `paused`
- **WHEN** a host calls `resume` two times, and the step pauses again after the first resume
- **THEN** the second pause still waits

#### Scenario: A list does not show a row of an ended workflow

- **GIVEN** a row of a pause of a turn whose workflow an operator canceled
- **WHEN** a host lists the active work of the analysis
- **THEN** the list does not hold that turn, and the row is gone

#### Scenario: A run that runs is active work

- **GIVEN** a run whose row is `running`, and no waiting workflow of the run
- **WHEN** a host lists the active work of the analysis
- **THEN** the list holds the run with the kind `run` and an empty `waiting`

#### Scenario: A turn that ended is not active work

- **GIVEN** a turn whose workflow ended
- **WHEN** a host lists the active work of the analysis
- **THEN** the list does not hold that turn

### Requirement: A stop of paused work ends it

The stop of a turn, the cancel of a run, and the stop of a data profile MUST end paused work, and they MUST delete the rows of the work. The stop of a turn in the process that runs the turn MUST end the wait through the abort of the turn. The turn then closes as `aborted`.

#### Scenario: A stop of a paused turn

- **GIVEN** a turn that waits in `paused`
- **WHEN** the host stops the turn
- **THEN** the turn record is `aborted`, the thread is free for a new turn, and the row of the pause is gone

#### Scenario: A cancel of a paused run

- **GIVEN** a run whose step waits in `paused`
- **WHEN** the run canceler cancels the run
- **THEN** the run row is `canceled`, and no row of a pause of the run is left

#### Scenario: A stop of a paused profile

- **GIVEN** a data profile that waits in `paused`
- **WHEN** the host stops the profile
- **THEN** the status of the profile workflow is `CANCELLED`, the profile row is `failed`, and no row of a pause of the profile is left

### Requirement: A person holds work that waits to retry

A wait in `retrying` MUST accept the message `{ kind: "hold" }` on the topic of its pause. On a hold, the wait MUST record its row as `paused` with no retry time, emit its part as `paused`, and wait for a resume with no timer. A wait in `paused` MUST ignore a hold. `CoreRuntime.work.hold` MUST send the hold to each wait of the work in `retrying`, with a key that names the pause, thus a second hold sends nothing new. It MUST give the count of those waits, and `not_found` for work of a different analysis than the session.

#### Scenario: A hold stops the timer of an outage

- **GIVEN** a run that waits in `retrying` after an outage
- **WHEN** a host holds the run
- **THEN** the row and the part of the wait read `paused`, the timer sends no request, and a resume sends the request again

## ADDED Requirements

### Requirement: A host stops active work

`CoreRuntime.work.stop(session, workId)` MUST end one work when it runs and when it waits in a pause. The stop MUST find the work in the `list` of the analysis of the session. A work that is not in that list MUST give `not_found`. Examples are a work of a different analysis, an unknown id, and a work that ended. A stop of a found work MUST give `stopped` with the item of the work.

#### Scenario: A stop of a paused turn through the surface

- **GIVEN** a turn that waits in `paused`
- **WHEN** a host calls `stop` with the turn id
- **THEN** the result is `stopped` with the item of the turn, the turn record is `aborted`, and the list of the analysis is empty

#### Scenario: A stop of work of a different analysis

- **GIVEN** a data profile that waits in `paused`
- **WHEN** a host calls `stop` with the id of the profile workflow and a session of a different analysis
- **THEN** the result is `not_found`, and the profile still waits

### Requirement: A stop uses the path of the kind of the work

The stop MUST use the path of the kind of the work:

- A turn: `chatTurns.stop` of the runtime.
- A run: a run canceler that the runtime makes with `createRunCanceler`, with the run charge, the run authorizer, and the provenance hook of the runtime.
- A data profile: `stopDataProfile` (see the `data-profile-init` capability).

#### Scenario: A stop of a paused run through the surface

- **GIVEN** a run whose step waits in `paused`
- **WHEN** a host calls `stop` with the run id
- **THEN** the result is `stopped` with the item of the run, the run row is `canceled`, and the list of the analysis is empty

#### Scenario: A stop of a paused profile through the surface

- **GIVEN** a data profile that waits in `paused`
- **WHEN** a host calls `stop` with the id of the profile workflow
- **THEN** the result is `stopped` with the item of the profile, and the profile row is `failed` with the error `DATA_PROFILE_STOPPED`
