## MODIFIED Requirements

### Requirement: A turn is appended atomically with monotonic sequence

`appendTurn(threadId, messages)` SHALL write all messages of a turn in one transaction, assigning each a `seq` that is monotonically increasing per thread. Each row SHALL store its model content as an AI SDK model-message envelope and a `tokens` count computed at write time. The same transaction SHALL touch the live thread's metadata row so thread listings ordered by `updated_at` reflect conversation activity; the touch SHALL only move `updated_at` forward (never to an earlier value than the row already holds) and SHALL NOT touch a soft-deleted row; and the touch SHALL never cost the turn — when no metadata row exists for the thread, or the row is soft-deleted, the touch updates zero rows, and when the touch itself fails it SHALL be rolled back on its own without failing the append or the turn's message writes.

`appendTurn` SHALL additionally accept the turn's reported usage rollup and store it, in the same transaction, on the LAST assistant row the turn writes — the row a reader associates with the reply, and where the figure is already rendered live. A turn that writes no assistant row SHALL store no rollup, there being no message on which it would mean anything.

The rollup SHALL be optional at every layer. A caller that supplies none, and a caller that supplies one reporting no quantity at all, SHALL both leave the row without one — a rollup that reports nothing is stored as absent rather than as a rollup of absences, so "no figure" has exactly one representation in storage. The write SHALL decide this with the same predicate the loop uses to decide whether a call reported anything, so the two cannot drift about what reporting nothing means. Rows written before the rollup existed SHALL read back without one, and SHALL NOT be backfilled: the figures were never recorded, so an absent rollup is the honest value.

Because the rollup is stored on the message row itself, anything that removes the row removes it — a retracted tail turn takes its rollup with it, and a cost attached to a turn no longer in the transcript cannot survive to be misattributed.

#### Scenario: A turn round-trips

- **GIVEN** a turn of one user message and one assistant reply
- **WHEN** `appendTurn` writes it and the thread is read back
- **THEN** both rows are present in order with their `seq` monotonically increasing

#### Scenario: The turn's rollup rides its assistant reply

- **GIVEN** a turn appended with a usage rollup
- **WHEN** the thread is read back
- **THEN** the rollup is on the turn's assistant row and on no other row of that turn

#### Scenario: A turn that reported nothing stores no rollup

- **GIVEN** a turn appended without a rollup
- **WHEN** the thread is read back
- **THEN** its assistant row carries no rollup rather than a zeroed one

#### Scenario: A rollup reporting no quantity is stored as absent

- **GIVEN** a turn appended with a rollup in which every quantity is absent
- **WHEN** the thread is read back
- **THEN** its assistant row carries no rollup, indistinguishable from a turn appended without one

#### Scenario: A retracted turn takes its rollup with it

- **GIVEN** a tail turn whose assistant row carries a rollup
- **WHEN** the turn is retracted
- **THEN** neither the row nor its rollup remains

#### Scenario: A turn with no reply stores no rollup

- **GIVEN** an aborted turn that persists only its user message
- **WHEN** it is appended with a rollup
- **THEN** no row carries the rollup and the append succeeds

#### Scenario: The rollup is written in the turn's own transaction

- **GIVEN** a turn whose write fails partway
- **WHEN** the transaction rolls back
- **THEN** neither the messages nor the rollup are present

### Requirement: Stored AI SDK messages convert to CortexMessage

A converter SHALL map stored AI SDK model-message envelopes to `CortexMessage` parts for the wire. Text content SHALL become text parts and tool calls SHALL become tool-call parts. Provider metadata or reasoning blocks the UI does not render SHALL be omitted from the display value without mutating the stored row. Consecutive same-role rows SHALL be coalesced into one message ONLY when that role is `assistant` (restoring the one-bubble-per-turn shape over the loop's per-step rows); adjacent `user` rows SHALL remain separate messages — they arise only from turns that persisted no reply, and merging them would fabricate a message the user never sent. A row carrying the interruption marker SHALL surface as `interrupted: true` on the `CortexMessage` it lands in (including when that row is coalesced into an assistant run); the field is optional and absent means not interrupted. A loop-synthesized user message (the marked truncation nudge) SHALL NOT render: it carries the `user` role only for the wire format, and displaying it would show the user words they never typed.

A stored rollup SHALL surface on the `CortexMessage` its row lands in, including when that row is coalesced into an assistant run, so a host renders a reloaded turn's cost from the read it already performs rather than correlating a second query. The field SHALL be optional, and absent SHALL mean no figure was reported.

A rollup SHALL survive a row that renders nothing, folding onto the assistant run that row trailed exactly as the interruption marker does: the rollup is a fact about the turn, not about what its row displays, so a turn whose last assistant row carried only unrendered content — reasoning alone — MUST NOT lose the figure to the empty-row drop. That loss is the disappearance this capability exists to prevent, arriving one layer later.

#### Scenario: A tool-using turn converts to CortexMessage

- **GIVEN** a stored assistant AI SDK message containing text and a tool call
- **WHEN** the converter runs
- **THEN** it yields a `CortexMessage` with a text part and a tool-call part

#### Scenario: Provider metadata is dropped from display without mutating storage

- **GIVEN** a stored message containing provider metadata not rendered by the UI
- **WHEN** the converter runs
- **THEN** the metadata is omitted from the `CortexMessage` and the stored row is unchanged

#### Scenario: A reloaded turn carries the figure it showed live

- **GIVEN** a turn stored with a usage rollup
- **WHEN** the converter runs
- **THEN** the resulting `CortexMessage` carries that rollup

#### Scenario: A coalesced assistant run keeps its rollup

- **GIVEN** several consecutive assistant rows of one turn, the last carrying the rollup
- **WHEN** they are coalesced into one message
- **THEN** that message carries the rollup

#### Scenario: A rollup on an unrendered row folds onto the run it trailed

- **GIVEN** a turn whose last assistant row carries the rollup but only unrendered content
- **WHEN** the converter runs
- **THEN** the assistant message that row trailed carries the rollup

#### Scenario: A message stored before rollups existed converts without one

- **GIVEN** an assistant row written with no rollup
- **WHEN** the converter runs
- **THEN** the `CortexMessage` carries no rollup and the conversion succeeds

## ADDED Requirements

### Requirement: The reported rollup and the windowing token count are not interchangeable

The stored rollup and the per-row `tokens` count SHALL remain distinct measurements. `loadRecent` SHALL continue to window by the `tokens` count and SHALL NOT read the rollup; a rollup SHALL NOT be presented as the row's token count, and the `tokens` count SHALL NOT be presented as reported usage.

They share a unit and neither is a substitute: `tokens` is an offline `js-tiktoken` approximation computed at write time for every row, including rows no provider ever saw, and exists so windowing never needs a provider figure; the rollup is what a provider reported for a whole turn, and is absent whenever nothing reported. Windowing on the rollup would break budgeting for every turn lacking one, and reporting `tokens` as usage would present an estimate as billing truth.

#### Scenario: Windowing ignores the rollup

- **GIVEN** a thread whose assistant rows carry rollups far larger than their `tokens` counts
- **WHEN** `loadRecent` windows by budget
- **THEN** the selection is identical to the same thread with no rollups stored

#### Scenario: A row with no rollup still windows

- **GIVEN** a thread whose rows carry no rollup at all
- **WHEN** `loadRecent` windows by budget
- **THEN** it selects by the `tokens` count exactly as before
