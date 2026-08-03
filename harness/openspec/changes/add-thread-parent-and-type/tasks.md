## 1. Schema

- [x] 1.1 Add `thread_type TEXT NOT NULL DEFAULT 'conversation'`, `parent_thread_id TEXT REFERENCES cortex_analysis_threads(thread_id) ON DELETE CASCADE`, and `parent_seq BIGINT` to the `addMigrations` array in `src/state/init.ts`, as three `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements.
- [x] 1.2 Add the same three columns to the `CREATE TABLE cortex_analysis_threads` statement in `src/state/init.ts`, so a fresh database provisions them directly. Keep every DDL comment free of a semicolon — the schema is split on `;`.
- [x] 1.3 Add `CREATE INDEX IF NOT EXISTS idx_cortex_analysis_threads_parent ON cortex_analysis_threads(parent_thread_id) WHERE deleted_at IS NULL`, beside the existing partial index on `analysis_id`.
- [x] 1.4 Comment the self-reference at the table: state that the cascade is a backstop, and that `purgeThread` deletes the subtree's messages explicitly because `messages` has no foreign key to reach.

## 2. Store types

- [x] 2.1 Declare the closed `ThreadType` union (`conversation` | `report`) in `src/memory/thread-store.ts`, with a comment on why the set is closed rather than free-form.
- [x] 2.2 Add `threadType`, `parentThreadId`, and `parentSeq` to `Thread` and to `ThreadRow`, and map them in `toThread`.
- [x] 2.3 Add the optional `type`, `parentThreadId`, and `parentSeq` inputs to `CreateThreadInput`, typing `type` as `ThreadType`.
- [x] 2.4 Declare the error variants `createThread` returns for the rules it enforces itself — an analysis mismatch, an unpaired anchor, and an out-of-set type — following the repository's domain-error vocabulary, and widen `createThread`'s return type to `ResultAsync<Thread, DbError | ThreadInputError>`.
- [x] 2.5 Add the optional `type` and `parentThreadId` filters to `ListThreadsInput`, documenting that an omitted filter narrows nothing — the opposite polarity to `includeArchived`, which widens.
- [x] 2.6 Document on the `ThreadStore` interface what each lifecycle verb does across the parent/child edge, and why unarchive stays on one row.
- [x] 2.7 Re-export `ThreadType` and `ThreadInputError` from `src/index.ts`. The spec puts the closed set in the store's public surface, and an embedder that imports `CreateThreadInput` cannot name its `type` field or match `createThread`'s error channel without them.

## 3. Create and list

- [x] 3.1 Write the parent-integrity check in `createThread`: reject a parent whose `analysis_id` differs from the child's, reject a parent with no `parentSeq`, reject a `parentSeq` with no parent, and reject a type outside the closed set. Gate every rule on the value being supplied, so a create with no parent and no anchor runs the same path it runs today. Keep it a data-integrity check, not a scope check.
- [x] 3.2 Leave the parent-exists case to the foreign key. Comment that `tryMutation` already classifies the rejection as `constraint_violation`, so a separate existence query would add a round trip and a check-to-insert window for nothing.
- [x] 3.3 Comment on `createThread` that the existing idempotency still wins: a conflicting insert evaluates no constraint and reads no supplied parent, so a caller that needs its values persisted compares them against the returned row.
- [x] 3.4 Persist the three new columns in `createThread`'s `INSERT` and return them in the `RETURNING` list and in the conflict read-back.
- [x] 3.5 Extend `listThreads`' row-scope fragment with the two optional filters, keeping the count and the page built from one fragment so they cannot disagree.
- [x] 3.6 Add the three columns to every `SELECT` list in the module (`createThread`, `getThread`, `updateTitle`, `listThreads`).

## 4. Lifecycle across the edge

- [x] 4.1 Rewrite `archiveThread` to stamp the named thread and every descendant, at any depth, with a recursive CTE. Keep the `deleted_at IS NULL` guard so an already-archived thread in the subtree keeps its original tombstone.
- [x] 4.2 Leave `unarchiveThread` acting on one row, and comment why the asymmetry removes the need for a column recording cascade-versus-deliberate archiving.
- [x] 4.3 Rewrite `purgeThread` to collect the subtree with a recursive CTE, delete every collected thread's `messages` rows, then delete the subtree's thread rows — all inside the existing transaction.
- [x] 4.4 Comment on `purgeThread` that the explicit delete must match the depth of the database cascade, and that a shallower delete reintroduces the orphan the cascade cannot prevent.

## 5. Tests

- [x] 5.1 Round-trip tests in `src/memory/thread-store.test.ts`: a create with no type or parent reads back as `conversation` with nulls; a create with all three reads them back unchanged; each member of the closed type set round-trips.
- [x] 5.2 Integrity tests: a parent in another analysis, a parent with no anchor, an anchor with no parent, and an out-of-set type each fail and write no row. An absent parent surfaces as a `constraint_violation`. An archived parent is accepted. A create with neither a parent nor an anchor writes its row untouched by any rule.
- [x] 5.3 An idempotency test: a repeat create for an existing `thread_id` naming an absent parent succeeds, returns the existing row unchanged, and writes nothing.
- [x] 5.4 Listing tests: an unfiltered listing returns every type; the `type` filter narrows and its total describes the narrowed set; the `parentThreadId` filter returns one thread's children only; both filters together narrow to one row.
- [x] 5.5 Archive tests: archiving a parent hides parent, child, and grandchild; a child archived earlier keeps its own `deleted_at`; unarchiving a parent leaves the children archived; unarchiving a child on its own restores it; neither verb moves `updated_at` on any row it reaches.
- [x] 5.6 Purge tests: purging a parent removes the messages and rows of parent, child, and grandchild; purging a child leaves the parent and its siblings unchanged.
- [x] 5.7 A `purgeAnalysis` test in `src/state/purge-analysis.test.ts` covering an analysis whose threads form a parent/child structure, asserting the single-statement delete raises no foreign-key error and leaves no thread or message row.

## 6. Verification

- [x] 6.1 Confirm `prepareChatTurn` needs no change: its `createThread` call names no type and no parent, so the defaults give it the same row it creates today.
- [x] 6.2 Run `tsc -p tsconfig.json`.
- [x] 6.3 Run the thread-store, thread-history, purge-analysis, and chat-turn test files against a Postgres reachable at `CORTEX_TEST_PG_URL`. Do not run the whole suite.
- [x] 6.4 Run `bun run format:file` on every changed file under `src/`.
