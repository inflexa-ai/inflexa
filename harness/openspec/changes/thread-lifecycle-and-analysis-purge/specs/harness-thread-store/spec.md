## MODIFIED Requirements

### Requirement: The thread store exposes thread operations via a DI factory

A `ThreadStore` SHALL be created via a dependency-injected factory bound to a Postgres pool (`createThreadStore(pool)`), exposing `createThread`, `getThread`, `updateTitle`, `archiveThread`, `unarchiveThread`, `deleteThread`, and `listThreads`. `getThread` SHALL return the row by `thread_id` and treat an archived row (`deleted_at` not null) as absent. `updateTitle` SHALL change only the `title` (and bump `updated_at`). `archiveThread` SHALL be a soft delete — it SHALL set `deleted_at` rather than removing the row, and SHALL leave the thread's `messages` rows intact; applied to an already-archived thread it SHALL be a no-op that preserves the original `deleted_at`. `unarchiveThread` SHALL clear `deleted_at` so the thread returns to `getThread` and `listThreads`, and SHALL be a no-op on a live or absent thread. `deleteThread` SHALL be a hard delete — it SHALL remove the thread's `messages` rows and its `cortex_analysis_threads` row in a single transaction, and SHALL succeed as a no-op when no such thread exists. `listThreads` SHALL return only live threads whose `analysis_id` matches the supplied scope, ordered by `updated_at` descending, with pagination (`page`, `perPage`) plus a total count and a `hasMore` flag. `updated_at` SHALL reflect thread activity: it is bumped by title updates and by turn appends (the thread-history `appendTurn` touches it in the turn's transaction — see `harness-thread-history`), so the listing order is most-recently-active first. The bump SHALL only move `updated_at` forward — never to a value earlier than the row already holds, so a slower writer cannot rewind a fresher one's timestamp — and SHALL NOT touch an archived row.

#### Scenario: Listing is scoped to one analysis

- **GIVEN** threads exist under analysis A and analysis B
- **WHEN** `listThreads` is called with analysis A's scope
- **THEN** only analysis A's live threads are returned, newest-updated first

#### Scenario: Listing paginates

- **GIVEN** more threads than one page holds
- **WHEN** `listThreads` is called with a `page` and `perPage`
- **THEN** it returns that page's threads plus the total count and a `hasMore` flag

#### Scenario: Update changes only the title

- **GIVEN** a live thread
- **WHEN** `updateTitle` is called
- **THEN** only the `title` (and `updated_at`) change and no other field is persisted

#### Scenario: Archive hides the thread and keeps everything

- **GIVEN** a live thread with persisted messages
- **WHEN** `archiveThread` is called
- **THEN** the thread no longer appears in `listThreads` or `getThread`, and its row and every one of its `messages` rows remain in storage

#### Scenario: Archiving twice preserves the original tombstone

- **GIVEN** a thread archived at time T
- **WHEN** `archiveThread` is called again
- **THEN** the call succeeds and the row's `deleted_at` still reads T

#### Scenario: Unarchive returns the thread to view

- **GIVEN** an archived thread with persisted messages
- **WHEN** `unarchiveThread` is called
- **THEN** the thread is returned by `getThread`, appears in `listThreads` for its analysis, and its messages are readable as before

#### Scenario: Delete removes the thread and its messages

- **GIVEN** a live thread with persisted messages
- **WHEN** `deleteThread` is called
- **THEN** the `cortex_analysis_threads` row is gone, no `messages` row remains for that `thread_id`, and `getThread` returns null

#### Scenario: Delete leaves no partial state when it fails

- **GIVEN** a thread whose delete fails partway
- **WHEN** the failure is observed
- **THEN** neither the thread row nor any of its messages have been removed

#### Scenario: Deleting an absent thread succeeds

- **GIVEN** a `thread_id` with no row and no messages
- **WHEN** `deleteThread` is called
- **THEN** the call succeeds and reports no error

#### Scenario: Activity reorders the listing

- **GIVEN** two live threads where the older-updated one receives a new appended turn
- **WHEN** `listThreads` runs for their analysis
- **THEN** the thread with the newer turn lists first

## ADDED Requirements

### Requirement: Hard delete reclaims only what the host has stopped writing

`deleteThread` SHALL guarantee that it creates no orphaned `messages` rows of its own, and SHALL NOT be specified as serialized against concurrent writers. A turn append that commits after the delete transaction persists messages under a `thread_id` with no metadata row, because `appendTurn` deliberately tolerates a missing metadata row (see `harness-thread-history`) and `messages` carries no foreign key to `cortex_analysis_threads`. Such rows are not attributable to any analysis and are therefore unreachable by any later thread-scoped or analysis-scoped reclamation. A host SHALL therefore stop writes to a thread — unbinding it from any live conversation — before invoking `deleteThread`; the store SHALL NOT attempt to enforce that, since it cannot observe the host's in-flight turns.

#### Scenario: Delete creates no orphan of its own

- **GIVEN** a live thread with persisted messages and no concurrent writer
- **WHEN** `deleteThread` completes
- **THEN** no `messages` row for that `thread_id` remains

#### Scenario: A turn committing after a delete is not recovered

- **GIVEN** a thread deleted while a turn append was in flight
- **WHEN** the append commits afterwards
- **THEN** its messages persist with no metadata row, and the store reports no error and makes no claim to have removed them
