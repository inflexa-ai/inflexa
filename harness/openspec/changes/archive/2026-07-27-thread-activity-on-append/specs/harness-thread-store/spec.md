## MODIFIED Requirements

### Requirement: The thread store exposes thread operations via a DI factory

A `ThreadStore` SHALL be created via a dependency-injected factory bound to a Postgres pool (`createThreadStore(pool)`), exposing `createThread`, `getThread`, `updateTitle`, `deleteThread`, and `listThreads`. `getThread` SHALL return the row by `thread_id` and treat a soft-deleted row (`deleted_at` not null) as absent. `updateTitle` SHALL change only the `title` (and bump `updated_at`). `deleteThread` SHALL be a soft delete — it SHALL set `deleted_at` rather than removing the row. `listThreads` SHALL return only live threads whose `analysis_id` matches the supplied scope, ordered by `updated_at` descending, with pagination (`page`, `perPage`) plus a total count and a `hasMore` flag. `updated_at` SHALL reflect thread activity: it is bumped by title updates and by turn appends (the thread-history `appendTurn` touches it in the turn's transaction — see `harness-thread-history`), so the listing order is most-recently-active first.

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

#### Scenario: Delete is soft and removes the thread from view

- **GIVEN** a live thread with persisted messages
- **WHEN** `deleteThread` is called
- **THEN** the thread no longer appears in `listThreads` or `getThread`, and its row and its messages remain in storage

#### Scenario: Activity reorders the listing

- **GIVEN** two live threads where the older-updated one receives a new appended turn
- **WHEN** `listThreads` runs for their analysis
- **THEN** the thread with the newer turn lists first
