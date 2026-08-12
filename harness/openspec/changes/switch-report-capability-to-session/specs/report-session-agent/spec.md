# report-session-agent Delta

## ADDED Requirements

### Requirement: The report turn reads the copied narrative, never the live memory

The turn assembly of a `report` thread MUST NOT inject the live working-memory render. The seed message in the child transcript carries the copy at the anchor, and that copy is the narrative record of the session. A live render sees state past the anchor, and that breaks the knowledge cap.

The assembly MUST read the thread type from the row that the turn preparation already loads. A `conversation` thread keeps the live render.

#### Scenario: A report turn carries no live render

- **WHEN** a turn runs on a `report` thread
- **THEN** the assembled tail holds no working-memory render, and the seed message stays the one narrative source

#### Scenario: A conversation turn keeps the live render

- **WHEN** a turn runs on a `conversation` thread
- **THEN** the assembled tail holds the working-memory render, as before

## MODIFIED Requirements

### Requirement: The snapshot pins at session start

The runtime MUST give an idempotent operation that makes sure that the session state of a thread exists. The first run of the operation MUST pin the snapshot with `pinReportSnapshot`, and it MUST write the row. Every later call MUST read the stored snapshot, and it MUST NOT pin again. A pin failure MUST return as typed data, and a later call can pin again, because no row was written.

The spawn MUST run the operation directly after the seed of the child lands. The spawn mints one moment, and the two pins of that moment are the anchor of the transcript and the snapshot of the data. A pin at the first tool call of a later turn reads a different moment. A run can register an artifact between the two, and the session then cites an artifact that the anchor never held.

A failed pin at the spawn MUST NOT fail the spawn, and it MUST NOT remove the child. The operation is idempotent, thus a later call pins again. The failure MUST reach the injected logger.

The serving path of a report turn MUST run the operation at the start of the turn. Thus a session that the spawn could not pin still anchors before its first tool call.

#### Scenario: The spawn pins the snapshot

- **WHEN** the spawn makes a report child
- **THEN** the session state of the child holds the snapshot before the first turn runs

#### Scenario: An artifact of a later run is not a member

- **GIVEN** a spawned report child
- **WHEN** a run registers a new artifact, and the first turn of the child then runs
- **THEN** the stored snapshot holds no entry for that artifact

#### Scenario: A failed pin at the spawn keeps the child

- **WHEN** the pin fails at the spawn
- **THEN** the spawn gives the child, and the next call pins again

#### Scenario: The first served turn pins before any tool call

- **WHEN** the first turn of a report thread starts
- **THEN** the row holds the snapshot before a tool of the roster runs

#### Scenario: The pin runs one time

- **WHEN** a thread makes two authoring calls
- **THEN** the artifact ledger query runs one time, and both calls read one snapshot

#### Scenario: The membership survives a restart

- **WHEN** the process restarts after the pin, and a new artifact lands in the ledger
- **THEN** the next call reads the stored snapshot, and the new artifact is not a member

#### Scenario: A pin failure does not poison the thread

- **WHEN** the first pin fails and the store recovers
- **THEN** the next call pins again, and the session continues
