# harness-thread-history Specification

## Purpose
Defines the harness `messages` table — the single source of truth for conversation turns — and the `ThreadHistory` API on top of it: the turn writes, the `loadRecent` view, the `loadAll` display read, and the tail retract. Each round is persisted atomically with a monotonic per-thread `seq`, content is stored as AI SDK model-message envelopes (see the ai-sdk-message-storage spec), and `loadRecent` gives the view of the latest compaction marker as a valid model-message sequence (no orphan tool result). Stored AI SDK messages convert to `ChatMessage` parts for the wire.

## Requirements

### Requirement: loadRecent emits a thread-overflow metric

Each `loadRecent` call MUST record an OTel metric with two values: the total token count of the thread, and the count of the turns that the view leaves out. A turn is left out when the view holds none of its messages. The attribute `eviction` MUST be true when the view leaves out at least one turn.

#### Scenario: Eviction is recorded

- **GIVEN** a thread of 8 turns whose summary marker sits in the sixth turn
- **WHEN** `loadRecent` runs
- **THEN** the metric reports `eviction: true` and 5 left-out turns

#### Scenario: A thread with no marker records no eviction

- **GIVEN** a thread with no marker
- **WHEN** `loadRecent` runs
- **THEN** the metric reports `eviction: false` and 0 left-out turns

### Requirement: Thread history is conversation-scoped

The `messages` table and `ThreadHistory` SHALL serve conversation threads only. Workflow and sandbox agent loops SHALL NOT write to it; their message durability is the DBOS step cache and is not migrated by the AI SDK thread-history backfill.

#### Scenario: The interface offers no generic message insert

- **GIVEN** the `ThreadHistory` interface
- **WHEN** a caller inspects it
- **THEN** it exposes only conversation-turn operations (for example `appendTurn`, `writeTurn`, `loadRecent`, `loadAll`, and `retractLastTurn`), not a generic row insert or row delete

### Requirement: A display read backs the messages endpoint

`ThreadHistory` SHALL provide a thread-scoped display read (`loadAll(threadId)`) of the `messages` table, which a host uses to serve the messages of a thread. It SHALL return every row of the thread oldest-first, grouped into whole turns, each row with its AI SDK model-message envelope, its stored display envelope, and its stored rollup. The grouping by whole turns keeps a multi-row turn and the display projection on its first row together. The read SHALL have no paginated form: it selects and parses every row of the thread, so a page would save no query and no parse, and would only truncate the answer. This read SHALL be distinct from `loadRecent` (which gives the view of the loop from the stored compaction markers) and SHALL NOT apply that view.

#### Scenario: The display read returns each turn of the thread

- **GIVEN** a thread with many turns
- **WHEN** `loadAll` is called
- **THEN** it returns every turn oldest-first, each with its model rows, display projection, and rollup

#### Scenario: The display read is not windowed

- **GIVEN** a thread whose latest compaction marker leaves earlier turns out of the view of the loop
- **WHEN** `loadAll` is called
- **THEN** it returns every turn, also the turns that the view leaves out

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

#### Scenario: Retract never removes part of a concurrently appending turn

- **GIVEN** a write of a group with more than one row, in a race with `retractLastTurn` on the same thread
- **WHEN** both complete
- **THEN** the thread holds the whole group or none of it, and never a part of it

### Requirement: The reported rollup and the windowing token count are not interchangeable

The stored rollup, the `tokens` count of a row, and the input tokens of a request MUST stay three different measurements. The check of a compaction budget MUST read the input tokens of the last request (see the harness-agent-loop capability). It MUST NOT read a rollup, and it MUST NOT read a `tokens` count. `loadRecent` MUST NOT read a rollup.

A rollup and the input tokens of a request MUST NOT be presented as the token count of a row. The `tokens` count MUST NOT be presented as reported usage.

The three share a unit, and none replaces another:

- The `tokens` count is an offline estimate of `js-tiktoken`. The write computes it for each row, also for a row that no provider saw. The thread-overflow metric adds it.
- The input tokens of a request are what the provider reported for the whole prefix of one request. They hold the system prompt, the tools, and the pictures at the count of the provider. Thus the check reads them.
- The rollup is what a provider reported for a whole turn. It adds the input of each request of the turn, and it is absent when no call reported. A budget on the rollup counts one prefix many times.

#### Scenario: Windowing ignores the rollup

- **GIVEN** a thread whose assistant rows carry rollups far larger than their `tokens` counts
- **WHEN** `loadRecent` gives the view
- **THEN** the view is the same as the view of the same thread with no rollup

#### Scenario: A row with no rollup still windows

- **GIVEN** a thread whose rows carry no rollup
- **WHEN** `loadRecent` gives the view
- **THEN** the markers decide the view, the same as for a thread whose rows carry rollups

#### Scenario: The check ignores the rollup and the tokens column

- **GIVEN** a thread whose rollups and whose `tokens` counts sum above the budget, and whose last reply carries input tokens under the budget
- **WHEN** the loop compares the figure with the budget before a request
- **THEN** no compaction runs

#### Scenario: A thread with no rollup still compacts

- **GIVEN** a thread whose rows carry no rollup, and whose last reply carries input tokens over the budget
- **WHEN** the loop compares the figure with the budget before a request
- **THEN** the loop compacts before it sends the request

#### Scenario: The input tokens of a request do not change the tokens column

- **GIVEN** an assistant message that carries 180,000 input tokens of its request
- **WHEN** the store appends the message
- **THEN** the `tokens` column of its row holds the estimate of the content of the message

### Requirement: A turn stores the author of its user message

`appendTurn` MUST accept an optional author of the turn, a string that names the identity that sent the user message. The write MUST store it in the same transaction as the messages. The author lands on the first row of the append when that row is a genuine user start, and on no other row. That row is the row that carries the display projection, thus the write and the transcript read use one row. A synthetic message and an assistant row MUST carry no author. A caller that supplies none MUST leave each row without one.

The write MUST strip NUL from the author before the insert, the same as it strips NUL from the envelope. Thus a NUL in the value cannot fail the append.

The author MUST be nullable in storage, with no default and no backfill. A row written before the author existed MUST read back without one, because the value was never recorded. The author rides the message row, thus a retracted tail turn takes its author with it.

The model read (`loadRecent`) MUST NOT carry the author, because the provider does not see it.

#### Scenario: The author rides the user row

- **GIVEN** a turn appended with an author
- **WHEN** the thread is read back
- **THEN** the author is on the row of the user message, and on no assistant row and no tool row of that turn

#### Scenario: A turn appended without an author stores none

- **GIVEN** a turn appended without an author
- **WHEN** the thread is read back
- **THEN** no row of the turn carries an author

#### Scenario: A mid-turn synthetic message carries no author

- **GIVEN** a turn appended with an author, whose rows hold a marked synthetic nudge between two assistant rows
- **WHEN** the thread is read back
- **THEN** the user row carries the author, and the nudge row and each assistant row carry none

#### Scenario: A record append carries no author

- **GIVEN** an out-of-band record append that supplies an author
- **WHEN** the thread is read back
- **THEN** the record row carries no author, because the record is not the message of a person

#### Scenario: An old row reads back without an author

- **GIVEN** a database whose `messages` table predates the author column
- **WHEN** the state initialization runs, and the thread is read back
- **THEN** the column exists, nullable with no default, and each existing row carries no author

#### Scenario: A NUL in the author does not fail the append

- **GIVEN** a turn appended with an author that holds a NUL character
- **WHEN** the thread is read back
- **THEN** the append succeeded, and the stored author is the value without the NUL

#### Scenario: The model read is unchanged by an author

- **GIVEN** a turn appended with an author
- **WHEN** `loadRecent` reads the thread
- **THEN** the returned model messages equal the appended model messages, and no message holds an author

#### Scenario: A retracted turn takes its author with it

- **GIVEN** a tail turn whose user row carries an author
- **WHEN** the turn is retracted
- **THEN** neither the row nor its author remains

### Requirement: The transcript read carries the author and the creation time

The display read (`loadAll`) MUST return the creation time of each row, and the author of each row that holds one. The creation time is the start time of the transaction that appended the row, thus each row of one append holds the same time. The store gives no order between the times of two appends. The `seq` column orders the rows. The two members MUST be optional on the stored message type, because a fake or a fixture builds one with no row behind it.

The transcript replay MUST set the creation time on each `ChatMessage` of an append, as an ISO 8601 string, from the row that opens that append. It MUST set the author on each `ChatMessage` of the append whose role is `user`, from the same row. The two fields MUST be optional on `ChatMessage`. An absent value MUST have no key on the message, thus an absent value never reads as a real one. An assistant message MUST carry no author.

The author and the creation time ride the message row only. The write MUST NOT copy either one into the display projection, under the same one-copy rule that keeps the rollup out of the projection.

#### Scenario: A reloaded turn carries its author and its time

- **GIVEN** a turn stored with an author
- **WHEN** the transcript replay runs
- **THEN** the user message carries the author and the creation time, and the assistant message carries the creation time and no author

#### Scenario: A turn stored without an author replays without one

- **GIVEN** a turn stored without an author
- **WHEN** the transcript replay runs
- **THEN** no message of the turn has an author key, and each message carries the creation time

#### Scenario: The creation time is the time of the append

- **GIVEN** a turn of more than one row, appended in one transaction
- **WHEN** the thread is read back
- **THEN** each row of the turn carries the same time, and each replayed message of the turn carries the ISO 8601 form of that time

#### Scenario: The display projection holds neither value

- **GIVEN** a turn appended with an author
- **WHEN** the stored display envelope of the turn is inspected
- **THEN** the envelope holds no author and no creation time

### Requirement: Stored display projections convert to CortexMessage

The transcript read SHALL be a concatenation of stored display projections: for each row carrying one, its ordered parts map to the Cortex/host display representation by moving each part's discriminant out of the stored part type, and nothing else is consulted. The read MUST NOT recognize a tool name, rebuild a card, resolve a call detail, or touch the filesystem or database, so a reloaded conversation cannot differ from the one that was shown. A row with no stored projection SHALL be skipped rather than reconstructed.

A stored rollup SHALL surface on the `CortexMessage` its append's reply produced, so a host renders a reloaded turn's cost from the read it already performs rather than correlating a second query. The field SHALL be optional, and absent SHALL mean no figure was reported. A rollup SHALL survive a row that displays nothing, folding onto the assistant reply of the append it belongs to: the rollup is a fact about what the turn cost, not about what its row displayed, so a turn whose last assistant row carried only unrendered content — reasoning alone — MUST NOT lose the figure. That loss is the disappearance this capability exists to prevent, arriving one layer later.

The rollup SHALL be persisted in exactly one place. It rides the model row that ended the turn and is folded in on read; it MUST NOT also be written into the display projection, because two durable copies of one fact can disagree.

#### Scenario: The stored projection is the whole of the read

- **GIVEN** a turn whose stored projection holds a card that the current tool resolver would build differently
- **WHEN** the transcript read runs
- **THEN** it returns the stored parts in order, and no resolver, workspace, or database is consulted

#### Scenario: A call's outcome and detail survive reload

- **GIVEN** a stored projection holding one call that succeeded with a detail, one that failed, one the user denied, and one cut off mid-flight
- **WHEN** the transcript read runs
- **THEN** each call reports its own outcome and its recorded detail, and the denial does not read as a failure

#### Scenario: A row written before display was persisted is skipped

- **GIVEN** a row with no stored display projection
- **WHEN** the transcript read runs
- **THEN** the row contributes no message, and no reconstruction is attempted

#### Scenario: An interrupted turn carries its flag through the read

- **GIVEN** a persisted turn whose production was interrupted
- **WHEN** the transcript read runs
- **THEN** the resulting assistant message carries the interruption state and unmarked messages do not

### Requirement: Legacy turns are migrated once, at startup

A turn stored before display projections were persisted SHALL be rendered from its model transcript exactly once — during startup migration — and the result frozen as its stored projection, so the reconstruction logic has no runtime caller.

The migration renderer SHALL map text to text parts, tool calls to tool-call parts or reconstructed cards, recover each call's outcome from its paired `tool-result` block and its detail from the persisted input, omit unrendered provider metadata and reasoning without mutating storage, coalesce consecutive assistant rows, keep adjacent user rows separate, drop synthetic user nudges, render a host-appended record as a `system` message, and surface interruption markers as `interrupted: true`.

#### Scenario: A legacy tool-using turn is migrated

- **GIVEN** a stored legacy assistant AI SDK message containing text and a tool call but no display projection
- **WHEN** startup migration runs
- **THEN** its text and tool/card display are frozen into a stored projection, and later reads use only that

#### Scenario: A legacy failed call is migrated as a failure

- **GIVEN** a legacy turn whose tool-result block records an error output
- **WHEN** startup migration runs
- **THEN** the frozen projection reports that call as failed rather than as a success

#### Scenario: Provider metadata is dropped from migrated display without mutating storage

- **GIVEN** a legacy stored message containing provider metadata not rendered by the UI
- **WHEN** startup migration runs
- **THEN** the metadata is omitted from the projection and the stored row is unchanged

#### Scenario: Adjacent user rows stay separate bubbles

- **GIVEN** legacy history holding two consecutive `user` rows
- **WHEN** startup migration runs
- **THEN** it yields two `user` messages, never one merged message

#### Scenario: The loop's truncation nudge never renders as a user bubble

- **GIVEN** a persisted turn containing a marked loop-synthesized user message between two assistant rows
- **WHEN** startup migration runs
- **THEN** no user-visible message appears for the nudge

### Requirement: The chat-turn history load answers each unanswered tool call

The chat-turn assembly MUST answer each tool call of the loaded window that has no result. The answer MUST be the not-run error result that the loop gives at its exit, byte-identical (refer to the harness-agent-loop capability). The assembly MUST insert the answer as one `tool` message, directly after the assistant message of the call and the tool messages that follow it. It MUST NOT remove or change a stored message. The stored rows do not change, because the answer exists only in the assembled messages.

The answer is a pure function of the window. Thus each turn that loads the same window sends the same prefix, and the prompt cache reads it back. The assembly MUST log one warn with the ids and the names of the answered calls. The warn is the only record that the stored thread and the assembled messages differ.

#### Scenario: A stored unanswered call is answered in place

- **GIVEN** a stored window whose assistant message carries a tool call with no result, and a user message after it
- **WHEN** the chat turn assembles its messages
- **THEN** the assistant message is unchanged, and a `tool` message with the not-run result sits between it and the user message

#### Scenario: Two turns send the same prefix

- **GIVEN** a thread with a stored unanswered call
- **WHEN** two turns load the same window
- **THEN** the two assembled prefixes are byte-identical

#### Scenario: An answered call is not touched

- **GIVEN** a stored window in which each tool call has its result
- **WHEN** the chat turn assembles its messages
- **THEN** the assembly adds no message and logs no warn

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

#### Scenario: An old row reads back without a duration

- **GIVEN** a row written before the duration existed
- **WHEN** the thread is read back
- **THEN** the row carries no duration, and no backfill runs

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

### Requirement: loadRecent gives the view of the latest compaction marker

`loadRecent(threadId, options)` MUST give the view of the thread. The view is a pure function of the stored messages. The loop uses the same function for each request of a run with a compaction policy (see the harness-agent-loop capability). `loadRecent` MUST NOT window by a token budget, and it MUST NOT window by a message count. The store deletes no row for a view. The stored markers decide what the view holds.

The view MUST obey this rule over the stored messages, in `seq` order:

- The head is the first turn of the thread when the option `keepFirstTurn` is set, and nothing when it is not set. The head ends at the next genuine user start, or at the first marker or exchange message.
- A message of a compaction exchange never joins the view.
- A summary marker becomes the front of the view, and it empties the body.
- A drop marker keeps the last turns of the body, by the count of turns that it carries. The drop marker itself never joins the view.
- A kept message of a drop loses its reasoning parts in the view. A message with no part left leaves the view. The stored row does not change.
- Each other message joins the body.
- The view is the head, then the latest summary marker, then the body.

Thus only the latest summary marker counts, and a drop keeps the last good summary in front. A message that the store holds after a drop marker keeps its reasoning. The view of a view is the same view.

A thread with no marker gives each stored message that is not a message of an exchange. The loop then compacts at the first request whose view exceeds its budget.

#### Scenario: A thread with no marker gives each message

- **GIVEN** a thread of 30 turns with no marker, whose total estimate exceeds 150,000 tokens
- **WHEN** `loadRecent` reads the thread
- **THEN** it gives each stored message in `seq` order

#### Scenario: Only the latest summary marker counts

- **GIVEN** a thread with two summary markers
- **WHEN** `loadRecent` reads the thread
- **THEN** the view starts with the second marker, and it holds no message that the store holds before that marker

#### Scenario: The exchange is not in the view

- **GIVEN** a thread whose last compaction stored an exchange and then a summary marker
- **WHEN** `loadRecent` reads the thread
- **THEN** no message of the view carries the exchange mark

#### Scenario: An exchange with no marker is not in the view

- **GIVEN** a thread whose last compaction stopped on an abort, with a stored exchange and no marker
- **WHEN** `loadRecent` reads the thread
- **THEN** the view holds each message of the thread except the messages of the exchange

#### Scenario: A report thread keeps its seed first

- **GIVEN** a report thread whose seed is its first turn, and a later summary marker
- **WHEN** `loadRecent` reads the thread with `keepFirstTurn`
- **THEN** the view starts with the seed, and then the summary marker

#### Scenario: A drop keeps the previous summary in front

- **GIVEN** a thread with a summary marker, later turns, and then a drop marker that keeps 2 turns
- **WHEN** `loadRecent` reads the thread
- **THEN** the view holds the summary marker, then the last 2 turns before the drop marker, then each message after the drop marker

#### Scenario: A kept message loses its thinking and a later message keeps it

- **GIVEN** a drop marker that keeps an assistant message with a reasoning part, and an assistant message with a reasoning part after the drop marker
- **WHEN** `loadRecent` reads the thread
- **THEN** the kept message has no reasoning part in the view, and the later message keeps its reasoning part
- **AND** each stored row is unchanged

#### Scenario: A retracted turn takes its marker with it

- **GIVEN** a tail turn that holds an exchange and a summary marker, after an earlier summary marker
- **WHEN** `retractLastTurn` removes the tail turn
- **THEN** `loadRecent` gives the view of the earlier summary marker

#### Scenario: The view of a view is the same view

- **GIVEN** the view of a thread with a summary marker and a later drop marker
- **WHEN** the view rule runs over that view
- **THEN** it gives the same messages, byte-identical

### Requirement: The view of loadRecent is a valid AI SDK model-message sequence

The view that `loadRecent` gives MUST be a valid AI SDK model-message sequence. It MUST NOT hold an orphan tool result, and it MUST NOT split a tool call from its result. A compaction starts only between two rounds, thus the messages after a marker start with no tool result. A drop keeps whole turns.

A turn boundary is a `user` message that a person sent. A `tool` message is not a boundary. A message that the harness synthesized is not a boundary either: the nudge after a truncated reply, a host record, a context record, a marker, and the request of an exchange.

The harness MUST mark such a message where it makes it. Each reader of a turn boundary MUST obey the same mark: the view, the display read, and the tail retract. A boundary in the middle of a turn splits that turn for all three.

The read MUST order the messages by the numeric `seq` column, never by a text form of it. A text sort puts `"10"` before `"2"`. It then reorders a thread past ten messages, and it splits a tool call from its result.

#### Scenario: The view after a marker starts with no tool result

- **GIVEN** a compaction that started after the tool message of a round
- **WHEN** `loadRecent` reads the thread
- **THEN** the first message after the summary marker is a context record, and each tool call of the view has its result

#### Scenario: A drop keeps whole turns

- **GIVEN** a drop marker that keeps 3 turns
- **WHEN** `loadRecent` reads the thread
- **THEN** the view holds each message of the 3 kept turns, and each tool call of the view has its result

#### Scenario: A thread past ten messages keeps numeric order

- **GIVEN** a thread with more than ten messages, whose tool call and tool result sit at `seq` 9 and `seq` 10
- **WHEN** `loadRecent` gives the view
- **THEN** the messages are in ascending numeric `seq` order, and the tool result comes directly after its tool call

### Requirement: The transcript read shows each compaction marker as a divider

The row of a compaction marker MUST carry the display projection of the marker. The projection is one `system` message with one `data-compaction` part at the status `done`. The part carries the id, `tokensBefore`, and the duration of the compaction. It also carries the trigger when the marker carries one. It carries no `tokensAfter`.

A compaction with no summary writes no marker. Thus a reload shows no divider for it. A divider that an older harness stored keeps its projection.

A message of a compaction exchange MUST carry no display projection. The stored display vocabulary MUST accept the `data-compaction` part, because the read drops a part with an unknown key.

The transcript replay gives each stored envelope in order. Thus a reload shows a divider at the position of the marker, and it shows nothing of the exchange. A divider between two rounds of one turn separates them, thus the two rounds show as two assistant messages.

#### Scenario: A summary marker replays as a divider

- **GIVEN** a stored turn with one round, a compaction that ended with a summary marker, and one more round
- **WHEN** the transcript replay runs
- **THEN** it gives the user message, an assistant message, a `system` message with the `data-compaction` part at `done`, and then an assistant message

#### Scenario: A compaction with no summary shows no divider

- **GIVEN** a stored turn whose compaction gave no summary
- **WHEN** the transcript replay runs
- **THEN** the replay holds no divider of that compaction, and no message of its exchange

#### Scenario: The divider carries the trigger

- **GIVEN** a stored summary marker with the trigger `turn-start`
- **WHEN** the transcript replay runs
- **THEN** the `data-compaction` part of the divider carries the trigger `turn-start`

#### Scenario: The exchange shows nothing

- **GIVEN** a stored compaction whose exchange holds a memory edit and a summary
- **WHEN** the transcript replay runs
- **THEN** no message of the replay holds the text of the summary or the call of the memory edit
