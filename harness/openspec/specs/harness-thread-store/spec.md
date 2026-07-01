# harness-thread-store Specification

## Purpose

The harness owns conversation-thread metadata in the `cortex_analysis_threads` table, exposed through the `ThreadStore` module (`thread-store.ts`). One row per conversation thread — keyed by the UI-generated `thread_id` (a random UUID; one analysis has many threads) — carries the analysis scope, title, timestamps, and a soft-delete tombstone that the harness `messages` table deliberately lacks.

This store exists because the harness keeps two message stores, selected by execution context, with no indirection between them. A conversation thread spans many HTTP requests, so turn N+1 must load turns 1..N — it needs a durable, queryable store (this table plus the `messages` table behind `ThreadHistory`; see the harness-thread-history spec). A workflow / sandbox agent loop, by contrast, runs inside one DBOS workflow body where the step cache is already the self-contained, replay-correct source of truth — writing those messages to a thread table would create a second source of truth that diverges on replay. So thread metadata and conversation messages are conversation-scoped only; their vocabulary is shaped so that reaching for them inside a workflow step is obviously wrong.

Authorization is not this store's job. The store's detail, title-update, and delete operations are keyed by `thread_id` alone and perform no analysis-ownership check — the host applies whatever access policy it runs at its edge before it invokes the store. `listThreads` is scoped to a single `analysis_id` as a query filter (an analysis's thread list), not as an auth gate.

## Requirements

### Requirement: Thread metadata is stored in a harness-native table

Conversation thread metadata SHALL be persisted in the harness-owned `cortex_analysis_threads` table. Each row SHALL carry `thread_id` (primary key, the UI-generated thread UUID), `analysis_id`, `title`, `created_at`, `updated_at`, and a nullable `deleted_at` (soft-delete tombstone; `NULL` means live). The table SHALL be indexed by `analysis_id` (live rows only) to support listing. It SHALL NOT carry a free-form `metadata` column — working memory lives in `cortex_working_memory`, and nothing else reads thread metadata.

#### Scenario: A thread row round-trips

- **GIVEN** a thread created with a `thread_id` and `analysis_id`
- **WHEN** the thread is read back by `thread_id`
- **THEN** its `analysis_id`, `title`, and timestamps are returned unchanged, with `deleted_at` null

#### Scenario: createThread is idempotent on thread_id

- **GIVEN** a thread already created with a `thread_id`
- **WHEN** a second create is attempted for that `thread_id`
- **THEN** no duplicate row is created and the existing row's `created_at` is preserved

### Requirement: The thread store exposes thread operations via a DI factory

A `ThreadStore` SHALL be created via a dependency-injected factory bound to a Postgres pool (`createThreadStore(pool)`), exposing `createThread`, `getThread`, `updateTitle`, `deleteThread`, and `listThreads`. `getThread` SHALL return the row by `thread_id` and treat a soft-deleted row (`deleted_at` not null) as absent. `updateTitle` SHALL change only the `title` (and bump `updated_at`). `deleteThread` SHALL be a soft delete — it SHALL set `deleted_at` rather than removing the row. `listThreads` SHALL return only live threads whose `analysis_id` matches the supplied scope, ordered by `updated_at` descending, with pagination (`page`, `perPage`) plus a total count and a `hasMore` flag.

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

### Requirement: Authorization is owned by the host

The thread store SHALL operate by `thread_id` alone for thread detail, title update, and delete; it SHALL NOT compare a thread's `analysis_id` against a request scope. Any caller-authorization policy SHALL be owned by the host and applied before it invokes the store.

#### Scenario: getThread is keyed by thread id alone

- **GIVEN** a thread owned by analysis B
- **WHEN** `getThread` is called with that `thread_id`
- **THEN** the live row is returned without the store comparing it against any request scope

#### Scenario: Host denies before invoking the store

- **GIVEN** the host determines a caller lacks access to an analysis
- **WHEN** the request is handled
- **THEN** the host does not call the thread store
