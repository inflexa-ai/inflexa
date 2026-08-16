## MODIFIED Requirements

### Requirement: A turn is appended atomically with monotonic sequence

`appendTurn(threadId, messages)` MUST write all messages of a turn in one transaction. Each message takes a `seq` that increases monotonically for each thread. Each row MUST store its model content as an AI SDK model-message envelope, and a `tokens` count computed at write time. The same transaction MUST touch the metadata row of the live thread, thus a listing ordered by `updated_at` reflects conversation activity. The touch only moves `updated_at` forward, and it does not touch a soft-deleted row. The touch never costs the turn: when no metadata row exists, or the row is soft-deleted, the touch updates zero rows. When the touch itself fails, it rolls back on its own, and the append and the message writes stand.

`appendTurn` MUST also accept the turn's reported usage rollup and store it, in the same transaction, on the LAST assistant row of the turn. That row is the one a reader associates with the reply, and the figure already renders there live. A turn that writes no assistant row stores no rollup, because no message exists that it would mean anything on.

`appendTurn` MUST also accept the duration of the turn, in milliseconds, and store it beside the rollup on that same row. The duration obeys the rules of the rollup: optional at every layer, absent when the caller supplies none, and never backfilled. The read MUST return it beside the rollup. Thus a reloaded transcript shows the duration that the live header showed.

The rollup MUST be optional at every layer. A caller that supplies none, and a caller that supplies one that reports no quantity, both leave the row without one. A rollup that reports nothing is stored as absent, not as a rollup of absences. Thus "no figure" has exactly one representation in storage. The write decides this with the same predicate that the loop uses to decide whether a call reported anything. Thus the two cannot drift about what reporting nothing means. Rows written before the rollup existed read back without one, and no backfill runs. The figures were never recorded, thus an absent rollup is the honest value.

The rollup and the duration are stored on the message row itself. Thus anything that removes the row removes them. A retracted tail turn takes its rollup and its duration with it. A cost attached to a turn no longer in the transcript cannot survive to be misattributed.

#### Scenario: A turn round-trips

- **GIVEN** a turn of AI SDK model messages appended to a thread
- **WHEN** the thread is read back
- **THEN** the messages return oldest-first with strictly increasing `seq`

#### Scenario: Provider metadata survives persistence

- **GIVEN** a message containing provider metadata required for continuation is appended
- **WHEN** it is read back
- **THEN** the provider metadata is byte-identical where AI SDK represents it

#### Scenario: Appending a turn bumps thread activity

- **GIVEN** two live threads under one analysis, where the older-updated thread receives a new turn
- **WHEN** the analysis's threads are listed ordered by `updated_at` descending
- **THEN** the thread that received the turn lists first, and its `updated_at` is at least the turn's write time

#### Scenario: A missing metadata row does not fail the append

- **GIVEN** a thread with persisted messages but no `cortex_analysis_threads` row
- **WHEN** `appendTurn` runs for that thread
- **THEN** the turn's messages persist normally and the touch affects zero rows

#### Scenario: A failing touch does not fail the append

- **GIVEN** a thread whose metadata row cannot be updated
- **WHEN** `appendTurn` runs for that thread
- **THEN** the append succeeds and every message of the turn persists

#### Scenario: A soft-deleted thread's tombstone is not touched

- **GIVEN** a soft-deleted thread that receives an appended turn
- **WHEN** `appendTurn` runs for that thread
- **THEN** the turn's messages persist, the row stays soft-deleted, and its `updated_at` is unchanged

#### Scenario: The turn's rollup rides its assistant reply

- **GIVEN** a turn appended with a usage rollup
- **WHEN** the thread is read back
- **THEN** the rollup is on the turn's assistant row and on no other row of that turn

#### Scenario: The turn's duration rides the same row

- **GIVEN** a turn appended with a duration
- **WHEN** the thread is read back
- **THEN** the duration is on the turn's assistant row, beside its rollup where one exists

#### Scenario: A turn that reported nothing stores no rollup

- **GIVEN** a turn appended without a rollup
- **WHEN** the thread is read back
- **THEN** its assistant row carries no rollup rather than a zeroed one

#### Scenario: A rollup reporting no quantity is stored as absent

- **GIVEN** a turn appended with a rollup in which every quantity is absent
- **WHEN** the thread is read back
- **THEN** its assistant row carries no rollup, indistinguishable from a turn appended without one

#### Scenario: An old row reads back without a duration

- **GIVEN** a row written before the duration existed
- **WHEN** the thread is read back
- **THEN** the row carries no duration, and no backfill runs

#### Scenario: A retracted turn takes its rollup with it

- **GIVEN** a tail turn whose assistant row carries a rollup and a duration
- **WHEN** the turn is retracted
- **THEN** neither the row, nor its rollup, nor its duration remains

#### Scenario: A turn with no reply stores no rollup

- **GIVEN** an aborted turn that persists only its user message
- **WHEN** it is appended with a rollup
- **THEN** no row carries the rollup and the append succeeds

#### Scenario: The rollup is written in the turn's own transaction

- **GIVEN** a turn whose write fails partway
- **WHEN** the transaction rolls back
- **THEN** neither the messages nor the rollup are present
