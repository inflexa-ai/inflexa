## RENAMED Requirements

- FROM: `### Requirement: Durable reactions are keyed against repeated delivery`
- TO: `### Requirement: A completion notice is keyed against repeated observation`

## REMOVED Requirements

### Requirement: A run's outcome is recorded durably in the conversation thread

**Reason**: The local server adds no guarantee beyond the harness and Cortex, and neither writes a run-outcome record on the thread. The record was the only writer that the TUI put on a thread outside a turn.
**Migration**: The run ledger is the durable record of the outcome. The agent reads a run state with its run tools, and the transient completion notice stays. A thread that already holds a record keeps it, and the transcript renders it as an event entry.

### Requirement: A run's failure message is bounded and delimited in the record

**Reason**: No run-outcome record is written on the thread.
**Migration**: None. The completion notice keeps only the start of a long failure reason, and it marks the cut.

### Requirement: Thread writes are serialized, and a racing user message queues

**Reason**: The per-thread write queue existed only to order the run-outcome record behind a turn, and the record is gone. The harness takes a per-thread lock on each write of a turn and on the retract.
**Migration**: None. A user message starts its turn at once.

### Requirement: The announcement path degrades rather than blocking

**Reason**: The path no longer appends a record to the thread, thus no append can fail. A failed read of the runs is the one fault left.
**Migration**: Refer to "A failed read of the runs degrades the announcement, never the chat".

## MODIFIED Requirements

### Requirement: A completion notice is keyed against repeated observation

Every user-visible reaction SHALL be keyed by the run id together with its terminal status. The TUI
detects a terminal transition from the runs snapshot that its sidebar reads from the local server,
and the server sends no event when a run ends. A durable-runtime recovery can move a run's row
through its terminal state again, and a later read observes it again, so a terminal transition can
be observed more than once; the keying is what stops a second observation producing a duplicate
notice.

A run SHALL be announced only when this client observed it non-terminal and then terminal. Thus the
first read after the TUI opens an analysis announces no run that had already finished, and a run that
starts and ends between two reads of this client is not announced. The snapshot covers each run of
the open analysis, whichever client or process started it. A run of a different analysis SHALL NOT
be announced while the user is away from it; when the user switches back, the next read announces
it.

Purely presentational state SHALL NOT need this keying: rendering from the newest observed state is
idempotent by construction.

#### Scenario: A recovered run announces once

- **WHEN** the durable runtime recovers and a later read observes a run's terminal state again
- **THEN** no second notice is raised

#### Scenario: Distinct runs are not conflated

- **WHEN** two different runs reach terminal statuses
- **THEN** each produces its own notice

#### Scenario: History is not news

- **WHEN** the TUI opens an analysis whose runs had already finished
- **THEN** no notice is raised for those runs

#### Scenario: A run that a different client started announces

- **WHEN** a run that a different client started reaches a terminal status, and this TUI observed it running
- **THEN** this TUI raises the notice of that run

## ADDED Requirements

### Requirement: A failed read of the runs degrades the announcement, never the chat

A failed read of the runs SHALL NOT raise a notice, and a failure in the announcement path SHALL NOT
affect the run, the sidebar, or the conversation. Announcement is an observation channel: the next
successful read announces each transition that it observes, and a fault in the channel is
survivable.

#### Scenario: A failed read raises no false notice

- **WHEN** a read of the runs fails while a run is active
- **THEN** no notice is raised, and the next successful read announces the run if it then reads terminal

#### Scenario: Announcement faults do not disturb the chat

- **WHEN** the announcement path errors
- **THEN** the conversation remains usable and no turn is failed or interrupted
