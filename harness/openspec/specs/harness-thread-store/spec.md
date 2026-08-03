# harness-thread-store Specification

## Purpose

The harness owns conversation-thread metadata in the `cortex_analysis_threads` table, exposed through the `ThreadStore` module (`thread-store.ts`). One row per conversation thread — keyed by the UI-generated `thread_id` (a random UUID; one analysis has many threads) — carries the analysis scope, title, timestamps, and a soft-delete tombstone that the harness `messages` table deliberately lacks. A row also records what kind of session it is, which thread spawned it, and the point in that parent's transcript where the spawn happened, so a report session can stand as a child of the analysis conversation that asked for it.

This store exists because the harness keeps two message stores, selected by execution context, with no indirection between them. A conversation thread spans many HTTP requests, so turn N+1 must load turns 1..N — it needs a durable, queryable store (this table plus the `messages` table behind `ThreadHistory`; see the harness-thread-history spec). A workflow / sandbox agent loop, by contrast, runs inside one DBOS workflow body where the step cache is already the self-contained, replay-correct source of truth — writing those messages to a thread table would create a second source of truth that diverges on replay. So thread metadata and conversation messages are conversation-scoped only; their vocabulary is shaped so that reaching for them inside a workflow step is obviously wrong.

Authorization is not this store's job. The store's detail, title-update, and delete operations are keyed by `thread_id` alone and perform no analysis-ownership check — the host applies whatever access policy it runs at its edge before it invokes the store. `listThreads` is scoped to a single `analysis_id` as a query filter (an analysis's thread list), not as an auth gate.

## Requirements

### Requirement: Thread metadata is stored in a harness-native table

Conversation thread metadata SHALL be persisted in the harness-owned `cortex_analysis_threads` table. Each row SHALL carry `thread_id` (primary key, the UI-generated thread UUID), `analysis_id`, `title`, `created_at`, `updated_at`, a nullable `deleted_at` (soft-delete tombstone; `NULL` means live), `thread_type` (not null, defaulting to `conversation`), a nullable `parent_thread_id` referencing `cortex_analysis_threads(thread_id)` with `ON DELETE CASCADE`, and a nullable `parent_seq` holding the parent thread's `messages.seq` at the moment the child was spawned. The table SHALL be indexed by `analysis_id` (live rows only) to support listing, and by `parent_thread_id` (live rows only) to support child listing. The three columns beyond the tombstone SHALL be introduced additively, so an existing row acquires `thread_type = 'conversation'` with a null parent and a null anchor and no backfill runs. It SHALL NOT carry a free-form `metadata` column — working memory lives in `cortex_working_memory`, and nothing else reads thread metadata.

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

### Requirement: The thread store exposes thread operations via a DI factory

A `ThreadStore` SHALL be created via a dependency-injected factory bound to a Postgres pool (`createThreadStore(pool)`), exposing `createThread`, `getThread`, `updateTitle`, `archiveThread`, `unarchiveThread`, `purgeThread`, and `listThreads`. `createThread` SHALL accept an optional `type`, an optional `parentThreadId`, and an optional `parentSeq` alongside the existing inputs. `getThread` SHALL return the row by `thread_id` and treat an archived row (`deleted_at` not null) as absent. `updateTitle` SHALL change only the `title` (and bump `updated_at`). `archiveThread` SHALL be a soft delete — it SHALL set `deleted_at` rather than removing the row, and SHALL leave the thread's `messages` rows intact; applied to an already-archived thread it SHALL be a no-op that preserves the original `deleted_at`. `unarchiveThread` SHALL clear `deleted_at` so the thread returns to `getThread` and `listThreads`, and SHALL be a no-op on a live or absent thread. `purgeThread` SHALL be a hard delete — it SHALL remove the thread's `messages` rows and its `cortex_analysis_threads` row in a single transaction, and SHALL succeed as a no-op when no such thread exists. How each of these three verbs acts on a thread's descendants is specified separately. `listThreads` SHALL return only live threads whose `analysis_id` matches the supplied scope, ordered by `updated_at` descending, with pagination (`page`, `perPage`) plus a total count and a `hasMore` flag. `listThreads` SHALL accept an optional `type` filter and an optional `parentThreadId` filter, each an exact match that narrows the result; an omitted filter SHALL NOT narrow anything, so a caller that supplies neither receives every type. `updated_at` SHALL reflect thread activity: it is bumped by title updates and by turn appends (the thread-history `appendTurn` touches it in the turn's transaction — see `harness-thread-history`), so the listing order is most-recently-active first. The bump SHALL only move `updated_at` forward — never to a value earlier than the row already holds, so a slower writer cannot rewind a fresher one's timestamp — and SHALL NOT touch an archived row.

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

### Requirement: Hard delete reclaims only what the host has stopped writing

`purgeThread` SHALL guarantee that it creates no orphaned `messages` rows of its own — for the named thread or for any of its descendants — and SHALL NOT be specified as serialized against concurrent writers. The database cascade on `parent_thread_id` removes a descendant's metadata row but cannot reach that descendant's `messages`, because `messages` carries no foreign key to `cortex_analysis_threads`; the explicit subtree delete is therefore what prevents the orphan, and the cascade stands behind it as a backstop. A turn append that commits after the delete transaction persists messages under a `thread_id` with no metadata row, because `appendTurn` deliberately tolerates a missing metadata row (see `harness-thread-history`). Such rows are not attributable to any analysis and are therefore unreachable by any later thread-scoped or analysis-scoped reclamation. A host SHALL therefore stop writes to every thread in the subtree — unbinding each from any live conversation — before invoking `purgeThread`; the store SHALL NOT attempt to enforce that, since it cannot observe the host's in-flight turns.

#### Scenario: Delete creates no orphan of its own

- **GIVEN** a live thread with persisted messages and no concurrent writer
- **WHEN** `purgeThread` completes
- **THEN** no `messages` row for that `thread_id` remains

#### Scenario: A descendant's messages go with the descendant

- **GIVEN** a parent thread with a child thread, each carrying messages, and no concurrent writer
- **WHEN** `purgeThread` runs on the parent
- **THEN** no `messages` row remains for the parent or for the child

#### Scenario: A turn committing after a delete is not recovered

- **GIVEN** a thread deleted while a turn append was in flight
- **WHEN** the append commits afterwards
- **THEN** its messages persist with no metadata row, and the store reports no error and makes no claim to have removed them

### Requirement: A child thread names an existing parent in the same analysis and pins an anchor

`createThread` SHALL reject a create whose named parent carries a different `analysis_id` than the child, a create that supplies a `parentThreadId` without a `parentSeq`, and a create that supplies a `parentSeq` without a `parentThreadId`. Every one of these rules SHALL be conditional on the caller supplying a parent or an anchor: a create that names neither is untouched by them, so first-turn conversation creation keeps working exactly as it does today. These are data-integrity rules, not authorization: they keep a parent edge inside one analysis and keep the checkpoint anchor paired with the edge it belongs to, and they SHALL NOT be read as the store comparing a caller's request scope against a row.

A parent that names no row SHALL be left to the foreign key. The constraint rejects the insert itself, and `tryMutation` already classifies a constraint rejection as the `constraint_violation` variant of `DbError`, so the store SHALL NOT issue a separate existence query for it.

`createThread` SHALL widen its error channel to carry the rules it does enforce itself. The added variants SHALL follow the repository's domain-error vocabulary — a string `type` plus the identifiers a caller needs — and SHALL distinguish an analysis mismatch from an unpaired anchor.

The pairing rule exists because a child thread's `parent_seq` is the frozen point in the parent's transcript that the child was spawned from. A parent edge with no anchor would leave a consumer no way to tell which prefix of the parent the child was built on.

The idempotency rule already specified for `createThread` takes precedence over all of this, and the store SHALL NOT be specified to override it. A create for a `thread_id` that already exists inserts nothing, so no constraint is evaluated and no supplied parent is read; the call returns the existing row unchanged. A caller that needs its supplied type, parent, or anchor to have been persisted SHALL compare them against the returned row.

#### Scenario: A create with no parent and no anchor is unaffected

- **WHEN** `createThread` is called with neither a `parentThreadId` nor a `parentSeq`
- **THEN** the row is written with a null parent and a null anchor, and no parent rule is evaluated

#### Scenario: A parent that does not exist is rejected by the constraint

- **WHEN** `createThread` is called with a new `thread_id` and a `parentThreadId` that names no row
- **THEN** the insert fails on the foreign key, the call returns a `constraint_violation`, and no row is written

#### Scenario: A repeat create returns the existing row without evaluating its parent

- **GIVEN** a thread that already exists
- **WHEN** `createThread` is called for that `thread_id` with a `parentThreadId` that names no row
- **THEN** the call succeeds, returns the existing row unchanged, and writes nothing

#### Scenario: A parent in another analysis is rejected

- **GIVEN** a thread owned by analysis B
- **WHEN** `createThread` is called under analysis A naming that thread as the parent
- **THEN** the create fails and no row is written

#### Scenario: A parent without an anchor is rejected

- **WHEN** `createThread` is called with a `parentThreadId` and no `parentSeq`
- **THEN** the create fails and no row is written

#### Scenario: An anchor without a parent is rejected

- **WHEN** `createThread` is called with a `parentSeq` and no `parentThreadId`
- **THEN** the create fails and no row is written

#### Scenario: An archived parent still satisfies the integrity check

- **GIVEN** an archived thread under analysis A
- **WHEN** `createThread` is called under analysis A naming that thread as the parent, with an anchor
- **THEN** the create succeeds, because the parent row exists and belongs to the analysis

### Requirement: The thread type is a closed set the store validates

`thread_type` SHALL hold one value from a closed set the harness defines: `conversation` and `report`. `conversation` is the default and describes the analysis conversation the product has always had. `report` describes a report session spawned from one.

The set SHALL be expressed as a type in the store's public surface, so `Thread.threadType` and `CreateThreadInput.type` both carry it and a caller cannot name a value outside it at compile time. `createThread` SHALL also reject an out-of-set value at run time, because a value read from a database row or crossing a package boundary is not covered by the compile-time type.

The set is closed rather than free-form because the thread's type selects the agent that runs it. That resolution is a separate capability, and it can only be exhaustive over a set with a known membership — a free-form column would push an unmatched value into a run-time fallback that no reader could enumerate.

#### Scenario: A thread created with no type defaults to conversation

- **WHEN** `createThread` is called with no `type`
- **THEN** the row's `thread_type` reads `conversation`

#### Scenario: Each member of the set round-trips

- **WHEN** a thread is created with `conversation` and another with `report`
- **THEN** each row reads back the type it was created with

#### Scenario: A type outside the set is rejected

- **WHEN** `createThread` is called with a `type` that is in neither set member
- **THEN** the create fails and no row is written

### Requirement: Archive acts on the whole subtree and unarchive acts on one thread

`archiveThread` SHALL stamp `deleted_at` on the named thread and on every descendant reachable through `parent_thread_id`, at any depth, so a hidden thread never leaves a visible child behind. It SHALL preserve the existing tombstone of any thread in the subtree that was already archived. `unarchiveThread` SHALL clear `deleted_at` on the named thread alone and SHALL leave every descendant as it found it. Neither verb SHALL touch `updated_at` on any row it reaches, for the reason `unarchiveThread` already carries: that column orders the listing by conversation activity, and moving a thread out of view or back into it is not activity.

The asymmetry is deliberate. A symmetric cascade would restore a child that a user had archived on its own before the parent was archived, so the schema would have to record whether a cascade or a deliberate action set each tombstone. With the asymmetry no row carries that distinction, and every archived thread is recovered the same way — by naming it, which a listing widened with `includeArchived` supplies.

#### Scenario: Archiving a parent hides its children

- **GIVEN** a live conversation thread with two live report threads as children
- **WHEN** `archiveThread` runs on the conversation thread
- **THEN** none of the three appear in `getThread` or in a default `listThreads`, and every row and message remains in storage

#### Scenario: Archiving reaches a grandchild

- **GIVEN** a live thread with a child, and that child with a child of its own
- **WHEN** `archiveThread` runs on the top thread
- **THEN** all three carry a `deleted_at` stamp

#### Scenario: A child archived earlier keeps its own tombstone

- **GIVEN** a child archived at time T, whose parent is archived later at time U
- **WHEN** the child's row is read
- **THEN** its `deleted_at` still reads T

#### Scenario: A cascade archive leaves the activity clock alone

- **GIVEN** a live conversation thread with a live child, each carrying an `updated_at` stamp
- **WHEN** `archiveThread` runs on the conversation thread and `unarchiveThread` runs on it afterwards
- **THEN** both rows carry the `updated_at` value they held before the archive

#### Scenario: Unarchiving a parent leaves its children archived

- **GIVEN** a conversation thread and its two child threads, all archived by one archive of the parent
- **WHEN** `unarchiveThread` runs on the conversation thread
- **THEN** the conversation thread returns to `getThread` and to a default `listThreads`, and both children stay archived

#### Scenario: An archived child is recovered by naming it

- **GIVEN** an archived child thread whose parent is live
- **WHEN** `unarchiveThread` runs on the child
- **THEN** the child returns to `getThread` and appears in a default `listThreads` for its analysis

### Requirement: Hard delete reclaims the whole subtree

`purgeThread` SHALL remove the named thread, every descendant reachable through `parent_thread_id` at any depth, and the `messages` rows of every thread in that set, in the single transaction it already opens. The message delete SHALL cover the same depth the database cascade covers, because the cascade removes descendant rows recursively and would otherwise leave a deeper thread's messages behind with nothing naming them. A failure partway SHALL leave the whole subtree intact — no thread stripped of its transcript, and no transcript with nothing naming it.

#### Scenario: Purging a parent removes its children

- **GIVEN** a conversation thread with two child threads, each carrying messages
- **WHEN** `purgeThread` runs on the conversation thread
- **THEN** no `cortex_analysis_threads` row and no `messages` row remains for any of the three

#### Scenario: Purging reaches a grandchild's messages

- **GIVEN** a thread with a child, and that child with a child of its own, each carrying messages
- **WHEN** `purgeThread` runs on the top thread
- **THEN** no `messages` row remains for any of the three threads

#### Scenario: Purging a child leaves its parent standing

- **GIVEN** a conversation thread with two child threads
- **WHEN** `purgeThread` runs on one child
- **THEN** that child and its messages are gone, and the conversation thread and the other child are unchanged

#### Scenario: A failed subtree delete leaves everything

- **GIVEN** a subtree whose delete fails partway
- **WHEN** the failure is observed
- **THEN** every thread row and every message in the subtree remains

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

### Requirement: Workflow transcripts remain internal execution cache state

Workflow and sandbox agent loop transcripts SHALL remain internal DBOS execution/cache state and SHALL NOT be migrated by the conversation thread-history startup backfill. Deployments of this change SHALL drain or cancel active DBOS workflows before enabling the AI SDK loop/runtime.

#### Scenario: Completed workflow cache is not migrated

- **WHEN** startup runs the thread-history AI SDK backfill
- **THEN** it migrates conversation `messages` rows only and does not rewrite DBOS operation outputs

#### Scenario: Active workflows are not replayed across the migration

- **WHEN** this change is deployed
- **THEN** operators drain or cancel active DBOS workflows before starting the AI SDK runtime

### Requirement: Analysis outputs remain Cortex-native results

Completed analysis outputs SHALL remain represented by Cortex-native ledgers, typed run streams, artifact records, files, vector entries, and working memory rows. Step summaries, synthesis JSON, reports, and artifact metadata SHALL NOT be converted to AI SDK model-message storage.

#### Scenario: Existing synthesis remains readable

- **GIVEN** a completed analysis run with `runs/{runId}/synthesis.json`
- **WHEN** the AI SDK message migration has run
- **THEN** the synthesis remains readable through the existing run/artifact output paths without a model-message migration

#### Scenario: Step summary remains a file-backed output

- **GIVEN** a completed step with `output/summary.md`
- **WHEN** the AI SDK message migration has run
- **THEN** the step summary remains available as a Cortex-native file/artifact result
