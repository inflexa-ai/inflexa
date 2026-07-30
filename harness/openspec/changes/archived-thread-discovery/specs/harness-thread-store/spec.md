## MODIFIED Requirements

### Requirement: The thread store exposes thread operations via a DI factory

A `ThreadStore` SHALL be created via a dependency-injected factory bound to a Postgres pool (`createThreadStore(pool)`), exposing `createThread`, `getThread`, `updateTitle`, `archiveThread`, `unarchiveThread`, `purgeThread`, and `listThreads`. Every returned `Thread` SHALL carry `deletedAt` — the archive tombstone, `null` on a live thread — so a caller can tell the two apart without inferring it from which query returned the row. `getThread` SHALL return the row by `thread_id` and treat an archived row (`deleted_at` not null) as absent. `updateTitle` SHALL change only the `title` (and bump `updated_at`). `archiveThread` SHALL be a soft delete — it SHALL set `deleted_at` rather than removing the row, and SHALL leave the thread's `messages` rows intact; applied to an already-archived thread it SHALL be a no-op that preserves the original `deleted_at`. `unarchiveThread` SHALL clear `deleted_at` so the thread returns to `getThread` and `listThreads`, and SHALL be a no-op on a live or absent thread. `purgeThread` SHALL be a hard delete — it SHALL remove the thread's `messages` rows and its `cortex_analysis_threads` row in a single transaction, and SHALL succeed as a no-op when no such thread exists. `listThreads` SHALL return threads whose `analysis_id` matches the supplied scope, ordered by `updated_at` descending, with pagination (`page`, `perPage`) plus a total count and a `hasMore` flag; it SHALL return only live threads unless the caller asks for archived ones. `updated_at` SHALL reflect thread activity: it is bumped by title updates and by turn appends (the thread-history `appendTurn` touches it in the turn's transaction — see `harness-thread-history`), so the listing order is most-recently-active first. The bump SHALL only move `updated_at` forward — never to a value earlier than the row already holds, so a slower writer cannot rewind a fresher one's timestamp — and SHALL NOT touch an archived row.

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

## ADDED Requirements

### Requirement: An archived thread is discoverable so it can be restored

`listThreads` SHALL accept an `includeArchived` flag that widens the listing to archived threads alongside live ones, so a host can offer a restore surface without holding thread ids it obtained elsewhere. The flag SHALL default to omitted-or-`false`, which returns live threads only — the behaviour every existing caller already depends on. When it is set, archived and live threads SHALL be returned together in the same `updated_at` descending order, and the total count and `hasMore` flag SHALL describe the same widened set the page was drawn from, so a caller can page through everything the listing reports. An archived thread in the result SHALL carry its `deletedAt` timestamp, which is the only thing distinguishing it from a live one. The store SHALL NOT offer a way to list archived threads to the exclusion of live ones; a caller wanting that filters on `deletedAt`, which the returned shape makes possible.

#### Scenario: The default listing still excludes archived threads

- **GIVEN** an analysis with one live and one archived thread
- **WHEN** `listThreads` is called without `includeArchived`
- **THEN** only the live thread is returned, and the total counts one

#### Scenario: Asking for archived threads returns both

- **GIVEN** an analysis with one live and one archived thread
- **WHEN** `listThreads` is called with `includeArchived` set
- **THEN** both threads are returned, and the archived one carries a non-null `deletedAt`

#### Scenario: The widened listing counts what it can page to

- **GIVEN** an analysis with more live-plus-archived threads than one page holds
- **WHEN** `listThreads` is called with `includeArchived` and a `perPage` smaller than that set
- **THEN** the total counts every live and archived thread, and `hasMore` is true

#### Scenario: A restored thread rejoins the default listing

- **GIVEN** an archived thread found through the widened listing
- **WHEN** `unarchiveThread` is called with the id it reported
- **THEN** the thread appears in a subsequent default `listThreads` with a null `deletedAt`
