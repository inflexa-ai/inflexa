## 1. Thread verbs: archive, unarchive, hard delete

- [x] 1.1 Add `archiveThread(threadId)` to the `ThreadStore` interface and its factory in `src/memory/thread-store.ts` — the current `deleteThread` body verbatim (`SET deleted_at = NOW() WHERE thread_id = $1 AND deleted_at IS NULL`), so re-archiving preserves the original tombstone.
- [x] 1.2 Add `unarchiveThread(threadId)` — clear `deleted_at`, a no-op on a live or absent row.
- [x] 1.3 Rewrite `deleteThread` as a hard delete: inside one `withTransaction` (`src/lib/db-result.ts`), delete the thread's `messages` rows, then its `cortex_analysis_threads` row. Absent thread succeeds as a no-op.
- [x] 1.4 Update the module docstring — its "Delete is soft: `deleteThread` sets `deleted_at`" paragraph is now false. State the three verbs and that a hard delete creates no orphan of its own but is not serialized against a concurrent `appendTurn`.
- [x] 1.5 Extend `src/memory/thread-store.test.ts` for: archive hides from `getThread`/`listThreads` while row and messages survive; archive twice preserves `deleted_at`; unarchive restores visibility and messages; hard delete removes row and messages; hard delete of an absent thread succeeds; a failing hard delete leaves both row and messages intact.

## 2. The workflow-purge seam

- [x] 2.1 Declare the `WorkflowPurger` seam in `src/execution/workflow-purger.ts` — cancel workflows by id, and delete workflows by id including descendants. Interface only; no engine import.
- [x] 2.2 Implement the realization over `DBOSClient.create({ systemDatabasePool })` so it needs no launched engine, returning `ResultAsync` per the neverthrow policy. Tolerate a missing `dbos` schema (Postgres `42P01`) as "nothing to purge", the way `sweepEphemeralWorkflows` does.
- [x] 2.3 Test the realization against the DBOS rig (`src/__tests__/setup/dbos.ts`): deleting a parent with `deleteChildren` removes the child step workflows' rows, and the cascade takes `operation_outputs`/`streams` with them; deleting an unknown id succeeds.

## 3. purgeAnalysis

- [x] 3.1 Create `src/state/purge-analysis.ts` as a factory closure over `{ pool, workflows, logger? }` returning `purgeAnalysis(analysisId)`, resolving `logger ?? createNoopLogger()` once per the harness logging rule.
- [x] 3.2 Collect workflow identity FIRST: the `run_id` values from `cortex_runs` for the analysis, plus the `dataprofile:{analysisId}:` namespace ids from `dbos.workflow_status`. Nothing may delete `cortex_runs` before this read completes.
- [x] 3.3 Cancel the collected workflows through the seam, surfacing any cancellation failure on the error channel instead of proceeding to the delete.
- [x] 3.4 Delete the collected workflows (with descendants) through the seam — before the `cortex_*` stage, so a failure here leaves the id mapping on disk for a retry.
- [x] 3.5 Delete the `cortex_*` rows: `messages` joined through `cortex_analysis_threads`, then `cortex_analysis_threads`, then `cortex_artifacts`, `cortex_step_executions`, `cortex_runs`, `cortex_working_memory`, `cortex_asks`, `cortex_ask_grants`, and `cortex_analysis_state` last so its cascade takes `cortex_plans`.
- [x] 3.6 Drop the analysis's vector table using the shared `searchIndexName(analysisId)` derivation from `src/workspace/search-config.ts` and the identifier guard already in `src/state/vector-store.ts`; an absent table is a normal outcome.
- [x] 3.7 Return an outcome type reporting threads, messages, and workflows removed plus whether a vector index was dropped, on the `Result` ok channel; every failure returns on the error channel and never reports a completed purge.
- [x] 3.8 Test with `withSchema` (`src/__tests__/setup/postgres.ts`) plus the DBOS rig: a fully-populated analysis leaves no analysis-keyed row anywhere; a second analysis and a target assessment are untouched; scheduled workflow rows survive; an unknown analysis succeeds reporting nothing; a second purge succeeds; a data-profile workflow is reclaimed; a purge that cannot cancel reports an error.

## 4. Public surface

- [x] 4.1 Export `purgeAnalysis`'s factory, the `WorkflowPurger` seam and its realization from `src/index.ts`, beside the existing seams and their local realizations.
- [x] 4.2 Confirm the changed `ThreadStore` surface reaches embedders through the barrel and that no harness-internal caller still expects `deleteThread` to be soft (`grep -rn "deleteThread" src`).

## 5. Verification

- [x] 5.1 `tsc -p tsconfig.json` clean.
- [x] 5.2 `bun test` green with `CORTEX_TEST_PG_URL` exported at a running pgvector Postgres — a bare `bun test` cannot start the testcontainer under podman.
- [x] 5.3 `bun run format:file` on every touched file under `src/` only.
- [x] 5.4 Grep the diff for comments citing spec artifacts, change names, task numbers, or PR history and inline the rationale instead; comments state the current constraint, never where it came from.

## 6. Review findings

- [x] 6.1 Retire the `deleteThread` name and ship `purgeThread`, so a stale consumer fails to build rather than upgrading into silent transcript loss.
- [x] 6.2 Validate the `analysisId` at the entry point against a shape serving both the SQL-identifier and workflow-namespace jobs, with the coupling stated where the guard lives.
- [x] 6.3 State the quiesce precondition on `purgeAnalysis` and narrow the outcome's re-run promise; report the workflow count as targeted-before-delete rather than reclaimed.
- [x] 6.4 Distinguish an absent engine schema (nothing to purge) from a missing workflow table beneath one (a failure).
- [x] 6.5 Carry the engine's stack through the logger adapter instead of dropping it.
- [x] 6.6 Own the SQL identifier shape in one place, bound its length, and make the presence probe and the drop agree on quoting.
- [x] 6.7 Cover all seven cascading ledger tables, seed each before asserting its post-purge zero, and pin the set against the live catalog.
- [x] 6.8 Reclaim each test file's own seeded ledger rows in `afterAll`, scoped by its executor id.
- [x] 6.9 Extract the duplicated ledger seeder into one shared test fixture.

