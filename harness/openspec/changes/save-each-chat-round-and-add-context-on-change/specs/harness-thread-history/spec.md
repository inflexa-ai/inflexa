## RENAMED Requirements

- FROM: `### Requirement: A turn is appended atomically with monotonic sequence`
- TO: `### Requirement: Each round is appended atomically with monotonic sequence`

## MODIFIED Requirements

### Requirement: Each round is appended atomically with monotonic sequence

The store MUST write each group of rows in one transaction. A group is the opening of a chat turn, one round, a failure note, or a record of a host. `appendTurn(threadId, turn)` writes one group, and `writeTurn(threadId, write)` writes the groups of a chat turn.

Each row takes a `seq` that increases monotonically for each thread. Each row MUST store its model content as an AI SDK model-message envelope, and a `tokens` count that the write computes. The display content does not add to that count.

The versioned display envelope of a group MUST ride the first row of that group. Thus one ordered read of the rows gives each projection in sequence, with no join and no grouping pass. A tail retraction removes each envelope with the row that it describes.

A chat turn writes more than one group: the opening, each round when it completes, and the close. Thus the turn is not one transaction, but each group is. A group never lands in part, and the groups of one turn land in the order of the turn.

The transaction MUST touch the metadata row of the live thread, thus a listing ordered by `updated_at` shows the conversation activity. The touch only moves `updated_at` forward, and it does not touch a soft-deleted row.

The touch never costs the write. When no metadata row exists, or the row is soft-deleted, the touch updates zero rows. When the touch itself fails, it rolls back on its own, and the write stands.

`appendTurn` MUST NOT store a usage rollup or a duration. The close of a chat turn stores the two figures on its turn record. A row that an earlier version wrote keeps its rollup and its duration, and the read gives them back. No backfill runs.

#### Scenario: A round round-trips

- **GIVEN** a round of model messages and display messages that the store appended to a thread
- **WHEN** the thread is read back
- **THEN** the rows return oldest-first with strictly increasing `seq`, and the display projection is on the first row of the round

#### Scenario: Provider metadata survives persistence

- **GIVEN** a message with provider metadata that a continuation must have
- **WHEN** the message is appended and read back
- **THEN** the provider metadata is byte-identical where AI SDK represents it

#### Scenario: Model and display projections commit together

- **WHEN** a write fails after it started to write either projection
- **THEN** the transaction rolls back both the model messages and the display envelope

#### Scenario: Two rounds are two groups

- **GIVEN** a chat turn with two rounds
- **WHEN** the thread is read back
- **THEN** each round carries its own display envelope on its first row, and the rows of the second round come after the first round

#### Scenario: Appending bumps thread activity

- **GIVEN** two live threads under one analysis, and the thread with the older `updated_at` gets a new group
- **WHEN** a listing gives the threads of the analysis by `updated_at` in descending order
- **THEN** the thread that got the group lists first, and its `updated_at` is at least the write time of the group

#### Scenario: A missing metadata row does not fail the append

- **GIVEN** a thread with stored messages but no `cortex_analysis_threads` row
- **WHEN** the store appends a group to that thread
- **THEN** the rows of the group land, and the touch affects zero rows

#### Scenario: A failing touch does not fail the append

- **GIVEN** a thread whose metadata row cannot be updated
- **WHEN** the store appends a group to that thread
- **THEN** the write succeeds, and each row and the display envelope land

#### Scenario: A soft-deleted tombstone is not touched

- **GIVEN** a soft-deleted thread that gets an appended group
- **WHEN** the write completes
- **THEN** the rows land, the thread stays soft-deleted, and its `updated_at` does not change

#### Scenario: An old row keeps its figures

- **GIVEN** a row that an earlier version wrote with a rollup and a duration
- **WHEN** the thread is read back
- **THEN** the row carries the same rollup and the same duration

### Requirement: The tail turn can be retracted

`retractLastTurn(threadId)` MUST remove the most recent turn of the thread in one transaction. It removes each row from the last genuine-user-start `seq` onward, and each turn record whose `start_seq` is at or past that `seq`.

The retract obeys the append-only rule of the stored conversation. When the last turn goes, each earlier prefix stays byte-identical. Thus each earlier thinking block and each cache entry stays valid. The rule is: a later request never sees a changed earlier record. Only the last turn can go.

A thread whose rows hold no genuine user start MUST NOT change. The operation deletes nothing, and it reports the distinct outcome `no-user-turn`. A write of the harness cannot make such rows, and a refusal is better than a thread that the store empties in silence.

The operation MUST take the per-thread lock of `appendTurn` and `writeTurn`. Thus it removes a whole group, and never a part of a group that a write still makes. A host MUST NOT retract a turn whose status is `open`, because a later round of that turn would land after the cut.

The success value MUST give the count of the rows that the operation removed. A retract of an empty thread is the normal outcome `empty-thread`, not an error. The error channel MUST carry database faults only. The store MUST NOT remove a turn other than the tail, and it MUST NOT remove one message.

#### Scenario: Retract restores the pre-append thread

- **GIVEN** a thread with stored turns, and then one more `appendTurn` of one user message
- **WHEN** `retractLastTurn` is called
- **THEN** the appended rows are gone, and `loadRecent` gives what it gave before that append

#### Scenario: A multi-row tail turn is removed whole

- **GIVEN** a thread whose most recent turn has more than one row: the user input, the context records, the assistant steps, and the tool results
- **WHEN** `retractLastTurn` is called
- **THEN** each row of that turn is gone, and the turn before it becomes the tail

#### Scenario: A loop-synthesized message is not a cut point

- **GIVEN** a tail turn with a message that the loop synthesized in the middle of the turn, to continue a truncated reply
- **WHEN** `retractLastTurn` is called
- **THEN** the store removes the whole turn from its real head, and never from the synthesized message onward

#### Scenario: A retract removes the turn record

- **GIVEN** a closed chat turn at the tail of a thread
- **WHEN** `retractLastTurn` is called
- **THEN** no row and no turn record of that turn remains

#### Scenario: The earlier turns stay byte-identical

- **GIVEN** a thread with two closed chat turns
- **WHEN** `retractLastTurn` removes the second turn
- **THEN** each row of the first turn is byte-identical to its state before the retract, and its turn record does not change

#### Scenario: Retracting an empty thread is a normal outcome

- **GIVEN** a thread with no rows
- **WHEN** `retractLastTurn` is called
- **THEN** it succeeds with the outcome `empty-thread`, and it gives no `DbError`

#### Scenario: A thread without a user-start row is refused

- **GIVEN** a thread whose rows hold no user-role message
- **WHEN** `retractLastTurn` is called
- **THEN** no row goes, and the outcome is `no-user-turn`

#### Scenario: Retract never removes part of a concurrent write

- **GIVEN** a write of a group with more than one row, in a race with `retractLastTurn` on the same thread
- **WHEN** both complete
- **THEN** the thread holds the whole group or none of it, and never a part of it

## ADDED Requirements

### Requirement: A chat turn has a turn record

The store MUST keep one turn record for each chat turn, in the table `cortex_thread_turns`. The key of a record is the thread id and the `seq` of the user row that opens the turn. A record holds the status, the failure reason, the usage rollup, the duration, the open time, and the close time.

`writeTurn` MUST add the record with the status `open` in the transaction that stores the opening. It MUST close the record in the transaction that stores the last rows of the turn. The close sets the status `done`, `aborted`, or `failed`, the reason of a failure, the rollup, and the duration. The close changes only a record whose status is `open`.

A rollup that reports no quantity MUST be stored as absent. The write decides this with the predicate that the loop uses to decide whether a call reported a quantity. A duration of zero is a figure, and only an absent duration means that no process measured the turn.

The record holds no message. The messages of the turn are rows of `messages`, and a close never changes one. Thus the stored history stays append-only.

The display read (`loadAll`) MUST give the record on the user row that opens its turn. An `appendTurn` of a host record makes no turn record.

#### Scenario: An opening adds an open record

- **WHEN** `writeTurn` stores the opening of a chat turn
- **THEN** the thread has a turn record with the status `open`, keyed by the `seq` of the user row

#### Scenario: A close sets the outcome and the figures

- **GIVEN** an open turn record
- **WHEN** `writeTurn` closes it as `failed` with a reason, a rollup, and a duration
- **THEN** the record carries the status `failed`, the reason, the rollup, the duration, and a close time

#### Scenario: A rollup with no quantity stays absent

- **WHEN** `writeTurn` closes a turn with a rollup in which each quantity is absent
- **THEN** the record carries no rollup

#### Scenario: A second close changes nothing

- **GIVEN** a turn record with the status `done`
- **WHEN** a write tries to close it again as `failed`
- **THEN** the record keeps the status `done`

#### Scenario: A host record makes no turn record

- **WHEN** a host appends a record with `appendTurn`
- **THEN** the thread gets the record row, and no turn record

#### Scenario: The display read gives the record on the user row

- **GIVEN** a closed chat turn
- **WHEN** `loadAll` reads the thread
- **THEN** the user row that opens the turn carries the turn record, and no other row carries it

### Requirement: The transcript read merges the rounds of a turn

The transcript replay (`storedMessagesToCortex`) MUST merge the stored display messages of the rounds of one turn into one assistant message. Two stored assistant messages merge when they are next to each other and share one id. The merged message holds the parts in the stored order. A reconciling part replaces its earlier copy with the same type and the same id, at the position of the earlier copy.

The merged message keeps the creation time of its first round. The replay MUST fold the turn record onto the last assistant message of its turn:

- the rollup as `usage`
- the duration as `durationMs`
- `interrupted: true` when the status is `aborted`

A turn with no turn record keeps the fold of the rollup and the duration from its rows. A failure note stays a `system` message after the assistant message of its turn.

#### Scenario: Two rounds replay as one assistant message

- **GIVEN** a stored turn whose two rounds carry display messages with one assistant id
- **WHEN** the transcript replay runs
- **THEN** it gives one user message and one assistant message with the parts of both rounds, in order

#### Scenario: The record folds its figures and the interruption

- **GIVEN** a stored turn whose record is `aborted`, with a rollup and a duration
- **WHEN** the transcript replay runs
- **THEN** the assistant message of the turn carries the rollup, the duration, and `interrupted: true`

#### Scenario: An old turn keeps its row figures

- **GIVEN** a turn that an earlier version stored, with no turn record and a rollup on its last assistant row
- **WHEN** the transcript replay runs
- **THEN** the assistant message of the turn carries that rollup

#### Scenario: The failure note replays as a system message

- **GIVEN** a failed turn with one round and a failure note
- **WHEN** the transcript replay runs
- **THEN** it gives the user message, the assistant message, and then a `system` message with the text of the note
