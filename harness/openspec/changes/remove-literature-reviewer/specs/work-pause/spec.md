# Spec Delta

## MODIFIED Requirements

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
