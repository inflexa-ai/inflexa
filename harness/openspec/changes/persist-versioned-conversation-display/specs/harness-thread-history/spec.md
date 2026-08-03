## MODIFIED Requirements

### Requirement: A turn is appended atomically with monotonic sequence

`appendTurn(threadId, turn)` SHALL write the turn's model messages, its display projection, and its reported usage rollup in one transaction, assigning each model message a `seq` that is monotonically increasing per thread. The turn value carries all three, so there is one way to append and no way to persist a turn whose display was silently dropped.

The versioned display envelope SHALL be attached to the FIRST row of the append. Every append has a first row — a conversation turn's genuine user message, or the lone record row of an out-of-band host append — so one ordered read of a thread's rows yields every projection in sequence without a join or a grouping pass, and a tail retraction removes each envelope with the row it describes.

Each row SHALL store its model content as an AI SDK model-message envelope and a `tokens` count computed at write time; display content SHALL NOT contribute to that count. The same transaction SHALL touch the live thread's metadata row so thread listings ordered by `updated_at` reflect conversation activity; the touch SHALL only move `updated_at` forward (never to an earlier value than the row already holds) and SHALL NOT touch a soft-deleted row; and the touch SHALL never cost the turn — when no metadata row exists for the thread, or the row is soft-deleted, the touch updates zero rows, and when the touch itself fails it SHALL be rolled back on its own without failing the append or the turn's message or display writes.

The reported usage rollup SHALL be stored on the LAST assistant row the turn writes — the row a reader associates with the reply, and where the figure is already rendered live. A turn that writes no assistant row SHALL store no rollup, there being no message on which it would mean anything. The rollup SHALL be optional: a caller that supplies none, and a caller that supplies one reporting no quantity at all, SHALL both leave the row without one, so "no figure" has exactly one representation in storage. The write SHALL decide this with the same predicate the loop uses to decide whether a call reported anything, so the two cannot drift. Rows written before the rollup existed SHALL read back without one and SHALL NOT be backfilled: the figures were never recorded, so absent is the honest value.

Because both the rollup and the display envelope are stored on message rows, anything that removes the row removes them — a retracted tail turn takes its cost and its display with it.

#### Scenario: A turn round-trips

- **GIVEN** a turn of model messages and display messages appended to a thread
- **WHEN** the thread is read back
- **THEN** the model rows return oldest-first with strictly increasing `seq` and the display projection is on the append's first row

#### Scenario: Provider metadata survives persistence

- **GIVEN** a message containing provider metadata required for continuation is appended
- **WHEN** it is read back
- **THEN** the provider metadata is byte-identical where AI SDK represents it

#### Scenario: Model and display projections commit together

- **WHEN** an append fails after beginning to write either projection
- **THEN** the transaction rolls back both the model messages and the display envelope

#### Scenario: Appending a turn bumps thread activity

- **GIVEN** two live threads under one analysis, where the older-updated thread receives a new turn
- **WHEN** the analysis's threads are listed ordered by `updated_at` descending
- **THEN** the thread that received the turn lists first, and its `updated_at` is at least the turn's write time

#### Scenario: A missing metadata row does not fail the append

- **GIVEN** a thread with persisted messages but no `cortex_analysis_threads` row
- **WHEN** `appendTurn` runs for that thread
- **THEN** the turn's model and display projections persist normally and the touch affects zero rows

#### Scenario: A failing touch does not fail the append

- **GIVEN** a thread whose metadata row cannot be updated
- **WHEN** `appendTurn` runs for that thread
- **THEN** the append succeeds and every model message and the display envelope persist

#### Scenario: A soft-deleted thread's tombstone is not touched

- **GIVEN** a soft-deleted thread that receives an appended turn
- **WHEN** `appendTurn` runs for that thread
- **THEN** the turn persists, the row stays soft-deleted, and its `updated_at` is unchanged

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

#### Scenario: A retracted turn takes its rollup and its display with it

- **GIVEN** a tail turn whose assistant row carries a rollup and whose first row carries a display envelope
- **WHEN** the turn is retracted
- **THEN** neither the rows, the rollup, nor the envelope remain

#### Scenario: A turn with no reply stores no rollup

- **GIVEN** an aborted turn that persists only its user message
- **WHEN** it is appended with a rollup
- **THEN** no row carries the rollup and the append succeeds

#### Scenario: The rollup is written in the turn's own transaction

- **GIVEN** a turn whose write fails partway
- **WHEN** the transaction rolls back
- **THEN** neither the messages, the rollup, nor the display envelope are present

### Requirement: A paginated message read backs the messages endpoint

`ThreadHistory` SHALL provide a thread-scoped, paginated read (`loadPage(threadId, page, perPage)`) of the `messages` table for serving the thread messages endpoint, returning whole turns with their AI SDK model-message envelopes, their stored display envelopes, and their stored rollups, oldest-first, together with `total`, `page`, `perPage`, and `hasMore`. Pagination SHALL be by whole turns — `page`, `perPage`, and `total` count turns, not rows — so a multi-row turn and the display projection on its first row always reload together. This read SHALL be distinct from `loadRecent` (which windows model messages by token budget for the LLM) and SHALL NOT apply token-budget eviction.

#### Scenario: A page of turns is returned with totals

- **GIVEN** a thread with more turns than one page holds
- **WHEN** the paginated read is called with a page and perPage
- **THEN** it returns that page oldest-first with each turn's model rows, display projection, and rollup, plus `total` and `hasMore`

#### Scenario: The display read is not token-windowed

- **GIVEN** a thread whose model-message tokens exceed the loop budget
- **WHEN** the paginated read is called
- **THEN** it returns turns by page boundaries, not by token budget, and evicts nothing

## ADDED Requirements

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

## REMOVED Requirements

### Requirement: Stored AI SDK messages convert to CortexMessage

**Reason**: Split into two requirements with distinct lifetimes — the runtime read of stored projections, and the one-time startup migration of legacy turns. Holding both in one requirement is what let reconstruction remain a runtime path.

**Migration**: Replaced by "Stored display projections convert to CortexMessage" and "Legacy turns are migrated once, at startup" in this change.
