## MODIFIED Requirements

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

- **GIVEN** a turn whose literature reviewer meets a `suspend` error
- **WHEN** the reviewer pauses
- **THEN** the row of the reviewer holds the turn id as its work id
- **AND** the stream of the turn holds a `data-pause` part of the reviewer

#### Scenario: A resume clears the row and the part

- **GIVEN** a step that waits in `paused`
- **WHEN** the user resumes the run
- **THEN** the row of the step is gone, and the latest `data-pause` part of the step has the state `running`

#### Scenario: A paused lease workflow shows under its step

- **GIVEN** a sandbox step whose lease workflow pauses at the label gate
- **WHEN** the `acquire` of the step reads the row of the lease workflow
- **THEN** the row holds the run id as its work id and `run` as its work kind
- **AND** the stream of the step holds a `data-pause` part of the lease workflow

## ADDED Requirements

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

## REMOVED Requirements

### Requirement: A pause is a durable wait inside the workflow

**Reason**: The requirement drops the derivation of a chat turn, which goes away. A MODIFIED block cannot drop a scenario, thus the requirement continues under a new name.

**Migration**: Refer to the ADDED requirement "A pause is a durable wait in the body of its workflow".
