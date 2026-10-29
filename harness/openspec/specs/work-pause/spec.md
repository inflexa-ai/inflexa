# work-pause Specification

## Purpose
Define how harness work pauses on a failure that a person or time can repair, how a host lists, resumes, holds, and stops that work, and how a pause keeps the run credential and the durable state of the work.

## Requirements

### Requirement: A failure that a person or time can repair pauses the work

Durable work MUST pause, and it MUST NOT fail, for these causes and only for these:

- `outage`: a model request fails with a `provider` error with `retryable: true`, after the retries of the envelope.
- `host`: a model request fails with a `suspend` error, or a gate inside a workflow gives an `err` with `suspend: true`. The cause carries the reason of the host.
- `credential`: a model request fails with an `auth` error, or a chat turn has no credential before a model request.

Durable work is a chat turn, a sub-agent of a turn, a run with its steps and its synthesis, and the data profile. Each other failure MUST fail the work as before. The harness MUST select a cause from the kind of the error or from the `suspend` flag. It MUST NOT select a cause from the text of an error message, and it MUST NOT read the reason of the host.

#### Scenario: A suspend error pauses a sandbox step

- **GIVEN** a provider whose `suspendOn` map is `{ 402: "payment_required" }`
- **WHEN** a model request of a sandbox step fails with the status `402`
- **THEN** the step pauses with the cause `{ kind: "host", reason: "payment_required" }`, and the step does not fail

#### Scenario: A refused request does not pause

- **GIVEN** a model request of a chat turn that fails with a `provider` error with the status `400`
- **WHEN** the turn gets the failure
- **THEN** the turn fails as before, and no pause starts

#### Scenario: The text of an error message does not start a pause

- **GIVEN** a model request that fails with the status `400` and a response body with the text `budget exceeded`
- **WHEN** the harness examines the failure
- **THEN** no pause starts

### Requirement: The loop sends the failed request again after a resume

When the loop runs in workflow code and a request series fails with a cause, the loop MUST pause. After the resume, it MUST run the series again with the requests that the series did not use. The steps that completed before the failure MUST stay in the conversation, and the loop MUST NOT run their tool calls again.

A live call that failed after its first output part leaves a partial reply. The loop MUST keep that reply as an interrupted reply. Then it MUST append one harness request that asks the model to continue its reply. A failed call with no partial reply MUST NOT change the conversation, thus the next request sends the same view.

The pause MUST apply to each request series of the loop: the series of the run, a follow-up request, and a compaction request.

#### Scenario: A resumed turn sends the same request

- **GIVEN** a turn whose second model request fails with a `suspend` error before its first output part
- **WHEN** the user resumes the turn
- **THEN** the turn sends a request whose messages equal the messages of the failed request
- **AND** the tool calls of the first round do not run again

#### Scenario: A partial reply continues

- **GIVEN** a live reply that fails with a retryable `provider` error after some text
- **WHEN** the timer of the pause sends the request again
- **THEN** the conversation holds the partial reply as an interrupted reply, and then one harness request to continue
- **AND** the stream of the turn keeps the partial text, and the new text comes after it

### Requirement: A gate refusal with the suspend flag pauses the work at the gate

When a gate inside a workflow gives an `err` with `suspend: true`, the work MUST pause with the cause `host` and the reason of the gate. After the resume, the work MUST call the gate again. These gates are inside a workflow:

- `RunCharge.open` of a run
- the label gate of a sandbox spawn, in the lease workflow of the sandbox
- `ArtifactRegistry.register` in a sandbox step

The lease workflow pauses under the work of the consumer of its lease, thus the resume of that work reaches it. The `acquire` of the consumer waits during the pause.

A gate that runs before the work starts MUST NOT pause. Its refusal stays a refusal.

#### Scenario: A refused spawn pauses the step

- **GIVEN** a `resolveSandboxLabels` hook that gives `err({ reason: "account_frozen", suspend: true })` and then `ok`
- **WHEN** a sandbox step acquires a lease, and the user resumes the run
- **THEN** the lease workflow pauses under the run before the first spawn makes a machine, and the `acquire` of the step waits
- **AND** the second spawn makes the sandbox, and the `acquire` of the step returns

### Requirement: An outage retries on a timer, and then it pauses

A pause MUST be in one of two states. In `retrying`, the system sends the request again at a deadline. In `paused`, only a resume ends the wait.

A pause with the cause `outage` MUST start in `retrying`. The deadline MUST come from `DBOS.now()`, thus a recovery keeps it. The delays of the default schedule are 1, 5, 15, and 30 minutes. After the last delay, the pause MUST go to `paused`. A host MUST be able to give its own schedule. An empty schedule sends an outage to `paused` at once.

A pause with the cause `host` or `credential` MUST start in `paused`. The server MUST NOT end a wait in `paused` by itself.

#### Scenario: An outage goes to paused at the cap

- **GIVEN** a schedule of two delays, and a provider that fails each request with a `503`
- **WHEN** a turn makes a model request
- **THEN** the turn waits in `retrying` with the attempt 1, then with the attempt 2, and then it waits in `paused`

#### Scenario: A recovery keeps the deadline

- **GIVEN** a step in `retrying` whose deadline is 5 minutes after its pause
- **WHEN** the host restarts 2 minutes after the pause
- **THEN** the step sends the request again 5 minutes after the pause, not 5 minutes after the restart

### Requirement: Each waiting workflow writes a row and a part

Before it waits, a workflow MUST write one row of its pause in `cortex_paused_work`, in a step. The row MUST hold these values:

- the workflow id, as the key
- the work id and the work kind: the turn id and `turn`, the run id and `run`, or the id of the profile workflow and `profile`
- the analysis id, and the thread id of a turn
- the state, the cause, the timer attempt, and the next retry
- the topic of the resume message, and the time of the pause

A sub-agent of a turn MUST write the turn id as its work id. A sandbox step and the synthesis of a run MUST write the run id. A lease workflow MUST write the work id and the work kind of the consumer of its lease.

The workflow MUST also write a `data-pause` part to the stream of its work. The part MUST carry the workflow id, the state, the cause, the timer attempt, and the next retry. When the wait ends, the workflow MUST delete its row and write the part again with the state `running`. The part MUST be a reconciling part, keyed by the workflow id.

A lease workflow cannot write to the stream of its consumer. Thus the `acquire` wait of the consumer MUST read the row of the lease workflow. Then it MUST write the part to the stream of the consumer.

#### Scenario: A paused sub-agent shows under its turn

- **GIVEN** a turn whose planner meets a `suspend` error
- **WHEN** the planner pauses
- **THEN** the row of the planner holds the turn id as its work id
- **AND** the stream of the turn holds a `data-pause` part of the planner

#### Scenario: A resume clears the row and the part

- **GIVEN** a step that waits in `paused`
- **WHEN** the user resumes the run
- **THEN** the row of the step is gone, and the latest `data-pause` part of the step has the state `running`

#### Scenario: A paused lease workflow shows under its step

- **GIVEN** a sandbox step whose lease workflow pauses at the label gate
- **WHEN** the `acquire` of the step reads the row of the lease workflow
- **THEN** the row holds the run id as its work id and `run` as its work kind
- **AND** the stream of the step holds a `data-pause` part of the lease workflow

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

### Requirement: A pause for a person suspends the run credential

The pause of a run, of a step of a run, of a sub-agent of a run, and of a profile SHALL record the run session of its workflow on its row. When the wait is in the state `paused`, or a person holds a wait in `retrying`, the pause SHALL call `RunAuthorizer.suspend` in a durable step, before it waits for the person. A wait in `retrying` SHALL NOT suspend, because its timer ends it with no person. A turn SHALL record no run session. A failed suspend SHALL NOT change the wait.

#### Scenario: A pause for a person suspends

- **GIVEN** a run with a run session that pauses with the cause `host`
- **WHEN** the pause writes its row
- **THEN** the row holds the run session, and `suspend` gets that session and the reason `paused:host`

#### Scenario: A held wait suspends

- **GIVEN** a run that waits in `retrying` after an outage
- **WHEN** a person holds the work
- **THEN** the row keeps the run session, and `suspend` gets the reason `paused:outage`

#### Scenario: A wait on the timer does not suspend

- **WHEN** an outage pauses a run in `retrying`, and the timer ends the wait
- **THEN** `suspend` is not called

### Requirement: A resume renews the run credential first

When a host resumes work whose rows hold a run session, `WorkSurface.resume` SHALL call `RunAuthorizer.renew` one time for the work, with that run session and the `auth` of the session of the resume, before it sends a message. When the gate refuses, the resume SHALL give `{ kind: "refused", reason }` with the reason of the host, SHALL send no message, and the work SHALL stay paused.

#### Scenario: A renewal opens the way

- **GIVEN** a paused run with a run session
- **WHEN** a host resumes it and the host renews the credential
- **THEN** the resume gives `resumed`, and the run sends its request again

#### Scenario: A refused renewal keeps the work paused

- **GIVEN** a paused run with a run session
- **WHEN** a host resumes it and the host refuses the renewal with the reason `r`
- **THEN** the resume gives `{ kind: "refused", reason: "r" }`, the row stays, and the run sends nothing

### Requirement: A pause is a durable wait in the body of its workflow

The workflow that meets a cause MUST wait inside its body with `DBOS.recv`, on a topic that holds the id of the pause. It MUST NOT cancel itself, and it MUST stay an active workflow. A recovery after a crash MUST return to the same wait from the checkpoints. A recovery MUST NOT resume the work.

Work inside a step MUST NOT pause, because a step cannot wait for a message. There the failure MUST leave as before.

#### Scenario: A paused run survives a restart

- **GIVEN** a run whose sandbox step waits in `paused`
- **WHEN** the host stops and starts again
- **THEN** the step waits in `paused` again, its row of the pause is unchanged, and no model request runs

#### Scenario: No workflow ends canceled for a pause

- **WHEN** a data profile pauses with the cause `host`
- **THEN** the status of its workflow is `PENDING`, and not `CANCELLED`
