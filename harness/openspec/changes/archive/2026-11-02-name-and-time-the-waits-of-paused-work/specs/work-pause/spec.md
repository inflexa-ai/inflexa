## ADDED Requirements

### Requirement: Each wait names what waits

Each wait MUST name what waits with one waiter. The kinds of waiter are these:

- `turn`: the workflow of a chat turn.
- `sub-agent`, with the agent id: the child workflow of a sub-agent. The agent id is the name of the sub-agent, the same as the `agentId` of the source of its frames.
- `step`, with the step id: the child workflow of a sandbox step of a run.
- `synthesis`: the workflow of a run, while its synthesis waits.
- `run`: the workflow of a run, while it waits at its charge gate before its steps start.
- `profile`: the workflow of a data profile.

A lease workflow MUST name the waiter of the consumer of its lease. A lease of a step names that step, and a lease of a data profile names `profile`.

The row of the pause, each `data-pause` part of the wait, and the item of the wait in `PausedWorkflow` MUST carry the waiter. A row that the harness wrote before it recorded the waiter has no waiter. The item of that wait, and a part that a mirror makes from that row, MUST then omit the waiter. The upgrade MUST NOT delete such a row.

#### Scenario: Two waiting steps of a run name their steps

- **GIVEN** a run whose steps `s1` and `s2` wait in `paused`
- **WHEN** a host lists the active work of the analysis
- **THEN** the item of the run holds two waiting workflows, with the waiters `{ kind: "step", stepId: "s1" }` and `{ kind: "step", stepId: "s2" }`
- **AND** the `data-pause` parts of the stream of the run give the same waiters

#### Scenario: A waiting sub-agent names its agent

- **GIVEN** a turn whose planner waits in `paused`
- **WHEN** a host lists the active work of the analysis
- **THEN** the waiting workflow of the planner has the waiter `sub-agent` with the agent id of the planner
- **AND** the `data-pause` part of the planner in the stream of the turn gives the same waiter

#### Scenario: The lease of a step names the step

- **GIVEN** a step `s1` whose lease workflow pauses at the label gate
- **WHEN** the `acquire` of the step mirrors the pause
- **THEN** the row of the lease workflow and its `data-pause` part hold the waiter `{ kind: "step", stepId: "s1" }`

#### Scenario: A run names the stage that waits

- **GIVEN** a run whose charge gate refuses with the suspend flag
- **WHEN** the run pauses
- **THEN** the row of the run holds the waiter `{ kind: "run" }`
- **AND** a later pause of the synthesis of the same run holds the waiter `{ kind: "synthesis" }`

#### Scenario: A row from before the upgrade has no waiter

- **GIVEN** a row of a pause with no waiter
- **WHEN** a host lists the active work of the analysis
- **THEN** the item of that wait has no waiter, and the row stays

### Requirement: The part of a wait keeps its start, its end, and its cause

Each `data-pause` part MUST carry `pausedAt`, the start of the wait in ISO 8601. A hold MUST keep the `pausedAt` of the wait.

The part that ends a wait has the state `running`. It MUST keep the cause, `pausedAt`, and the waiter of the wait. It MUST add `endedAt`, the time of the end in ISO 8601, and `end`. The value of `end` is one of these:

- `retry`: the deadline of a wait in `retrying` ended the wait.
- `resume`: a resume ended the wait.
- `abort`: a stop ended the wait.

The `endedAt` of a waiting workflow MUST come from a durable step. Thus a recovery writes the same time again. A wait whose clear step completed before the upgrade replays no time, and its end part then has no `endedAt`.

The wait of a consumer reads the pause of a lease workflow from its row. A lease workflow waits only at its label gate with the cause `host`, thus in `paused`, and it has no stop signal. When the row is gone, the mirrored part MUST keep the cause, `pausedAt`, and the waiter of the last row that the wait read. Its `endedAt` MUST be the time when the wait saw the end, and its `end` MUST be `resume`. A wait that read no row MUST emit no end part.

#### Scenario: A resume ends a paused turn

- **GIVEN** a turn that waits in `paused` with the cause `host`
- **WHEN** the user resumes the turn
- **THEN** the last `data-pause` part of the turn has the state `running`, the cause `host`, the `pausedAt` of the wait, an `endedAt`, and `end: "resume"`

#### Scenario: A stop ends a paused turn

- **GIVEN** a turn that waits in `paused`
- **WHEN** the host stops the turn in the process that runs the turn
- **THEN** the last `data-pause` part of the turn has the state `running`, the cause, the `pausedAt` of the wait, an `endedAt`, and `end: "abort"`

#### Scenario: The timer ends a wait in retrying

- **GIVEN** a step that waits in `retrying` after an outage
- **WHEN** the deadline of the wait passes
- **THEN** the last `data-pause` part of the step has `end: "retry"`, and its `endedAt` is not before the next retry of the wait

#### Scenario: A hold keeps the start of the wait

- **GIVEN** a run that waits in `retrying` after an outage
- **WHEN** a person holds the run
- **THEN** the `data-pause` part in `paused` has the same `pausedAt` as the part in `retrying`

#### Scenario: The stream of a step shows the end of a lease pause

- **GIVEN** a lease workflow of a step that waits in `paused` at the label gate
- **WHEN** the user resumes the run
- **THEN** the stream of the step holds a `data-pause` part of the lease workflow with the state `running` and `end: "resume"`
- **AND** that part keeps the cause and the `pausedAt` of the wait, and it has an `endedAt`

## MODIFIED Requirements

### Requirement: Each waiting workflow writes a row and a part

Before it waits, a workflow MUST write one row of its pause in `cortex_paused_work`, in a step. The row MUST hold these values:

- the workflow id, as the key
- the work id and the work kind: the turn id and `turn`, the run id and `run`, or the id of the profile workflow and `profile`
- the waiter of the wait
- the analysis id, and the thread id of a turn
- the state, the cause, the timer attempt, and the next retry
- the topic of the resume message, and the time of the pause

A sub-agent of a turn MUST write the turn id as its work id. A sandbox step and the synthesis of a run MUST write the run id. A lease workflow MUST write the work id and the work kind of the consumer of its lease.

The workflow MUST also write a `data-pause` part to the stream of its work. The part MUST carry the workflow id, the waiter, the state, the cause, the timer attempt, the next retry, and the start of the wait. When the wait ends, the workflow MUST delete its row and write the part again with the state `running` and the end of the wait. The part MUST be a reconciling part, keyed by the workflow id.

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

The runtime MUST give `CoreRuntime.work`, of the type `WorkSurface`, with `list(analysisId?)`, `stop(session, workId)`, `resume(session, workId)`, and `hold(session, workId)`. A work is a chat turn, a run, or a data profile. `WorkKind` gives its kind, and `Work` is one item of the list.

With an analysis id, `list` MUST give each active work of that analysis. With no analysis id, `list` MUST give each active work of each analysis. Each item MUST carry the analysis id of its work. The count of the reads of one `list` MUST NOT depend on the count of analyses or of work.

`list` MUST give one item for each work id. Each item MUST hold each active waiting workflow of the work in `waiting`, with its waiter. For a work that runs and does not wait, `waiting` MUST be empty. A workflow is active when its DBOS status is `PENDING` or `ENQUEUED`. `list` MUST find the work as follows:

- A turn: the turn that holds a thread, only when the workflow of the turn is active. A claim of a thread can stay after its turn ends.
- A run: each run whose row is `running`. The run canceler also closes a row whose workflow ended.
- A data profile: the profile whose row is `running`, only when the workflow that `data_profile_workflow_id` names is active.
- The work of each active waiting workflow.

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

#### Scenario: A list with no analysis id gives the work of each analysis

- **GIVEN** a turn of the analysis `a1` that waits in `paused`, and a run of the analysis `a2` whose step waits in `paused`
- **WHEN** a host calls `list` with no analysis id
- **THEN** the list holds the turn with the analysis id `a1` and the run with the analysis id `a2`, each with its waiting workflow

#### Scenario: A list with no analysis id and no work

- **GIVEN** no active work in any analysis
- **WHEN** a host calls `list` with no analysis id
- **THEN** the list is empty
