# Spec Delta

## ADDED Requirements

### Requirement: The store lists the newest threads over each analysis

The thread store MUST give `listRecentThreads`. It takes a limit and an optional thread type. It MUST give the live threads of each analysis, newest-updated first, and `thread_id` breaks a tie in ascending order, the order of `listThreads`. A type MUST narrow the result to that type, and an omitted type MUST narrow nothing. The read MUST give at most `limit` threads. The limit MUST be clamped to the range 1 to 200, the bounds of a page of `listThreads`.

The read MUST run as one SQL statement. It MUST walk the live threads through the index on the update time, thus it does not sort each thread of each analysis. Each returned `Thread` MUST carry the same fields as a thread of `listThreads`. A failed query MUST ride the error channel as a `DbError`.

#### Scenario: The newest threads over two analyses

- **GIVEN** analysis A with threads updated at 10:00 and 12:00, and analysis B with a thread updated at 11:00
- **WHEN** `listRecentThreads` runs with a limit of 2
- **THEN** it gives the thread of A updated at 12:00, then the thread of B

#### Scenario: An archived thread is absent

- **GIVEN** an archived thread with the newest update time
- **WHEN** `listRecentThreads` runs
- **THEN** the archived thread is not in the result

#### Scenario: The type narrows the result

- **GIVEN** a conversation thread and a newer report thread
- **WHEN** `listRecentThreads` runs with the `conversation` type
- **THEN** it gives the conversation thread only

#### Scenario: One statement serves the read

- **WHEN** `listRecentThreads` runs over threads of 20 analyses
- **THEN** it sends one query

## MODIFIED Requirements

### Requirement: Thread metadata is stored in a harness-native table

Conversation thread metadata SHALL be persisted in the harness-owned `cortex_analysis_threads` table. Each row SHALL carry `thread_id` (primary key, the UI-generated thread UUID), `analysis_id`, `title`, `created_at`, `updated_at`, a nullable `deleted_at` (soft-delete tombstone; `NULL` means live), `thread_type` (not null, defaulting to `conversation`), a nullable `parent_thread_id` referencing `cortex_analysis_threads(thread_id)` with `ON DELETE CASCADE`, and a nullable `parent_seq` holding the parent thread's `messages.seq` at the moment the child was spawned. Each row SHALL also carry `title_set_by_user` (not null, defaulting to `false`), which records whether a person set the title. The table SHALL be indexed by `analysis_id` (live rows only) to support listing, and by `parent_thread_id` over every row, live and archived alike, to support child listing and the subtree walk. An index on `updated_at` descending and `thread_id`, over the live rows only, MUST serve the listing of the newest threads over each analysis. A versioned migration MUST add that index. The `parent_thread_id` index SHALL carry no `deleted_at` predicate: the subtree walk must reach archived descendants and the referential trigger behind `ON DELETE CASCADE` is the database's own query, so neither can supply one, and Postgres uses a partial index only where it can prove the predicate holds. The three columns beyond the tombstone SHALL be introduced additively, so an existing row acquires `thread_type = 'conversation'` with a null parent and a null anchor and no backfill runs. The `title_set_by_user` column SHALL arrive through a versioned migration. The table SHALL NOT carry a free-form `metadata` column — working memory lives in `cortex_working_memory`, and nothing else reads thread metadata.

#### Scenario: A thread row round-trips

- **GIVEN** a thread created with a `thread_id` and `analysis_id`
- **WHEN** the thread is read back by `thread_id`
- **THEN** its `analysis_id`, `title`, and timestamps are returned unchanged, with `deleted_at` null

#### Scenario: createThread is idempotent on thread_id

- **GIVEN** a thread already created with a `thread_id`
- **WHEN** a second create is attempted for that `thread_id`
- **THEN** no duplicate row is created and the existing row's `created_at` is preserved

#### Scenario: A thread created without a type or a parent is a conversation

- **GIVEN** a create that names neither a type nor a parent
- **WHEN** the row is read back
- **THEN** its `thread_type` reads `conversation`, and its `parent_thread_id` and `parent_seq` are both null

#### Scenario: A child thread round-trips its type, parent, and anchor

- **GIVEN** a thread created with a type, a parent thread id, and a parent sequence number
- **WHEN** the thread is read back by `thread_id`
- **THEN** all three values are returned unchanged

#### Scenario: The update-time index exists

- **WHEN** the migrations ran
- **THEN** an index on `cortex_analysis_threads(updated_at DESC, thread_id)` for the live rows exists

### Requirement: The thread store exposes thread operations via a DI factory

A `ThreadStore` SHALL be created via a dependency-injected factory bound to a Postgres pool (`createThreadStore(pool)`), exposing `createThread`, `getThread`, `updateTitle`, `setAutoTitle`, `archiveThread`, `unarchiveThread`, `purgeThread`, `listThreads`, and `listRecentThreads`. Every returned `Thread` SHALL carry `deletedAt` — the archive tombstone, `null` on a live thread — so a caller can tell the two apart without inferring it from which query returned the row. `createThread` SHALL accept an optional `type`, an optional `parentThreadId`, and an optional `parentSeq` alongside the existing inputs. `getThread` SHALL return the row by `thread_id` and treat an archived row (`deleted_at` not null) as absent. `updateTitle` is the rename by a person: it SHALL change only the `title`, set `title_set_by_user` to `true` in the same statement, and bump `updated_at`. `archiveThread` SHALL be a soft delete — it SHALL set `deleted_at` rather than removing the row, and SHALL leave the thread's `messages` rows intact; applied to an already-archived thread it SHALL be a no-op that preserves the original `deleted_at`. `unarchiveThread` SHALL clear `deleted_at` so the thread returns to `getThread` and `listThreads`, and SHALL be a no-op on a live or absent thread. `purgeThread` SHALL be a hard delete — it SHALL remove the thread's `messages` rows and its `cortex_analysis_threads` row in a single transaction, and SHALL succeed as a no-op when no such thread exists. How each of these three verbs acts on a thread's descendants is specified separately. `listThreads` SHALL return threads whose `analysis_id` matches the supplied scope, ordered by `updated_at` descending, with pagination (`page`, `perPage`) plus a total count and a `hasMore` flag; it SHALL return only live threads unless the caller asks for archived ones. `listThreads` SHALL accept an optional `type` filter and an optional `parentThreadId` filter, each an exact match that narrows the result; an omitted filter SHALL NOT narrow anything, so a caller that supplies neither receives every type. `listRecentThreads` lists the newest live threads over each analysis, as its own requirement specifies. `updated_at` SHALL reflect thread activity: it is bumped by title updates and by turn appends (the thread-history `appendTurn` touches it in the turn's transaction — see `harness-thread-history`), so the listing order is most-recently-active first. The bump SHALL only move `updated_at` forward — never to a value earlier than the row already holds, so a slower writer cannot rewind a fresher one's timestamp — and SHALL NOT touch an archived row.

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
- **THEN** only the `title`, `title_set_by_user`, and `updated_at` change, `title_set_by_user` is `true`, and no other field is persisted

#### Scenario: Archive hides the thread and keeps everything

- **GIVEN** a live thread with persisted messages
- **WHEN** `archiveThread` is called
- **THEN** the thread no longer appears in the default `listThreads` or in `getThread`, and its row and every one of its `messages` rows remain in storage

#### Scenario: Archiving twice preserves the original tombstone

- **GIVEN** a thread archived at time T
- **WHEN** `archiveThread` is called again
- **THEN** the call succeeds and the row's `deleted_at` still reads T

#### Scenario: Unarchive returns the thread to view

- **GIVEN** an archived thread with persisted messages
- **WHEN** `unarchiveThread` is called
- **THEN** the thread is returned by `getThread`, appears in `listThreads` for its analysis, and its messages are readable as before

#### Scenario: A live thread reports no tombstone

- **GIVEN** a live thread
- **WHEN** it is returned by `getThread` or `listThreads`
- **THEN** its `deletedAt` is null

#### Scenario: Delete removes the thread and its messages

- **GIVEN** a live thread with persisted messages
- **WHEN** `purgeThread` is called
- **THEN** the `cortex_analysis_threads` row is gone, no `messages` row remains for that `thread_id`, and `getThread` returns null

#### Scenario: Delete leaves no partial state when it fails

- **GIVEN** a thread whose delete fails partway
- **WHEN** the failure is observed
- **THEN** neither the thread row nor any of its messages have been removed

#### Scenario: Deleting an absent thread succeeds

- **GIVEN** a `thread_id` with no row and no messages
- **WHEN** `purgeThread` is called
- **THEN** the call succeeds and reports no error

#### Scenario: Activity reorders the listing

- **GIVEN** two live threads where the older-updated one receives a new appended turn
- **WHEN** `listThreads` runs for their analysis
- **THEN** the thread with the newer turn lists first

#### Scenario: An unfiltered listing returns every type

- **GIVEN** an analysis holding a conversation thread and two report threads, all live
- **WHEN** `listThreads` runs with neither a `type` nor a `parentThreadId` filter
- **THEN** all three threads are returned

#### Scenario: The type filter narrows to one kind of thread

- **GIVEN** an analysis holding a conversation thread and two report threads
- **WHEN** `listThreads` runs with the `conversation` type filter
- **THEN** only the conversation thread is returned, and the total count describes that narrowed set

#### Scenario: The parent filter lists one thread's children

- **GIVEN** a conversation thread with two child threads, and another conversation thread with one child, all under one analysis
- **WHEN** `listThreads` runs with the first conversation thread as the `parentThreadId` filter
- **THEN** only its two children are returned

#### Scenario: Both filters narrow together

- **GIVEN** a conversation thread with one report child and one conversation child
- **WHEN** `listThreads` runs with that thread as the `parentThreadId` filter and `report` as the `type` filter
- **THEN** only the report child is returned, and the total count describes that narrowed set
