## MODIFIED Requirements

### Requirement: A turn is appended atomically with monotonic sequence

`appendTurn(threadId, messages)` SHALL write all messages of a turn in one transaction, assigning each a `seq` that is monotonically increasing per thread. Each row SHALL store its model content as an AI SDK model-message envelope and a `tokens` count computed at write time. The same transaction SHALL touch the thread's metadata row (`cortex_analysis_threads.updated_at = NOW()`), so thread listings ordered by `updated_at` reflect conversation activity; when no metadata row exists for the thread, the touch updates zero rows and the append SHALL still succeed.

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
