## Why

The harness has no analysis-delete path at all. Analysis deletion is embedder-only, so every delete flow leaves the analysis's entire Postgres footprint standing forever: threads and their messages, `cortex_analysis_state`, `cortex_artifacts`, runs and step executions, plans, working memory, asks and grants, the per-analysis pgvector table, and — measured on a live database, the part no prior framing of this work has accounted for — the DBOS rows that hold the sandbox agent transcripts and the whole run-event stream.

The proportions decide the shape of the fix. Attributing `dbos.operation_outputs` by workflow class on the dev database: analysis runs and their child step workflows account for **16 MB across 7098 rows**, while every analysis-keyed `cortex_*` table plus the vector index sums to roughly **1.8 MB**. A purge scoped to the `cortex_*` tables alone would reclaim about a tenth of what an analysis actually occupies and would still call itself a hard delete.

Second, `ThreadStore.deleteThread` is misnamed rather than missing. It writes a `deleted_at` tombstone and never touches the thread's `messages` rows — correct archive behaviour under a name that promises reclamation, with the honest verb ("Remove", "the transcript is kept") currently carried in embedder UI copy instead of in the store's contract. Giving the two behaviours two names is what lets an embedder offer a recoverable action and a final one without either lying.

## What Changes

- **`ThreadStore` gains `archiveThread`** — today's tombstone semantics under the honest name: set `deleted_at`, leave the row and its `messages` intact, hide it from `getThread` and `listThreads`.
- **`ThreadStore.deleteThread` becomes a hard delete** — **BREAKING**: it removes the thread row *and* its `messages` rows, where it previously only wrote a tombstone. The name keeps its meaning and its behaviour changes to match; every current caller is an embedder expecting the tombstone and must be re-pointed at `archiveThread`.
- **`ThreadStore` gains `unarchiveThread`** — clears `deleted_at`, returning the thread to `getThread`/`listThreads`. Included so "archive is recoverable" is an exercised guarantee rather than an untested claim.
- **New `purgeAnalysis(analysisId)`** — a harness-owned hard delete across every analysis-keyed table, the analysis's dynamic `search_<analysisId>` pgvector table, and its DBOS workflow footprint. Ordered so no step can strand what a later step was meant to reach, and cancel-before-delete so a live workflow cannot re-materialize the rows behind it.
- **New `WorkflowPurger` seam** — the narrow capability `purgeAnalysis` uses to cancel and delete workflows, with the DBOS realization shipped beside `createDbosRunLauncher`. State modules do not import the durability engine; this keeps the existing DBOS quarantine intact instead of opening a second hole in it.
- **Out of scope, named so it does not look covered**: the scheduled-workflow rows (watchdog, reaper, notification sweep) are unreachable from any analysis — 442 of 557 `workflow_status` rows on the measured database — and accumulate regardless of purging. That is a retention concern, not a purge one. Target assessments are a separate top-level entity and are untouched. Workspace file disposal stays the embedder's (it already ships). Parent/child cascade rules are defined against these verbs by the data-model sibling.

## Capabilities

### New Capabilities
- `analysis-purge`: What constitutes an analysis's persisted footprint, and the harness-owned operation that reclaims all of it — table coverage and delete ordering, the dynamic vector table, the DBOS reach via an injected `WorkflowPurger` seam, cancel-before-delete, idempotence, and partial-failure reporting.

### Modified Capabilities
- `harness-thread-store`: the single `deleteThread` (soft) operation becomes three verbs with distinct guarantees — `archiveThread` (soft, recoverable, hidden), `unarchiveThread` (restores), `deleteThread` (hard, row + `messages`). The store's factory surface and its delete-is-soft requirement both change.

## Impact

- **`harness/src/memory/thread-store.ts`** — three new/changed operations on `ThreadStore` and its factory; the module docstring's "Delete is soft" contract is no longer true as written.
- **New `harness/src/state/purge-analysis.ts`** (or equivalent) — the cross-table purge, taking `Pool` plus the `WorkflowPurger` seam as construction deps per the composition pattern.
- **New `harness/src/execution/workflow-purger.ts`** + a DBOS realization — the seam interface and its `DBOS.cancelWorkflow`/`deleteWorkflow` implementation. `DBOS.deleteWorkflows` requires `DBOS.launch()`; `DBOSClient.create({ systemDatabasePool })` does not, and a headless embedder path needs the latter, so the realization must not assume a launched engine.
- **`harness/src/index.ts`** — `purgeAnalysis`, the `WorkflowPurger` seam and its realization, and the changed `ThreadStore` surface all cross the embedder boundary.
- **No schema change.** Every table and key the purge needs already exists. `messages` carries no foreign key to `cortex_analysis_threads`, so its rows are reached by joining through the thread table rather than by cascade — a constraint on ordering, not a migration.
- **Downstream, tracked separately**: the CLI companion change re-points its session-remove flow at `archiveThread`, adds a delete verb, and calls `purgeAnalysis` from `analysis.delete` and `inflexa prune`. Every current `deleteThread` caller is in that embedder, so the breaking change lands with a paired consumer update rather than in isolation.
