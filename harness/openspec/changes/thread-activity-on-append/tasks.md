## 1. Implementation

- [x] 1.1 In `memory/thread-history.ts`, add the thread-metadata touch to `appendTurn`'s transaction: `UPDATE cortex_analysis_threads SET updated_at = NOW() WHERE thread_id = $1` after the turn's message inserts; zero rows affected is a normal outcome. Keep the DDL-comment-semicolon rule in mind if any DDL comment is edited.

## 2. Tests

- [x] 2.1 `thread-history.test.ts`: appending a turn bumps the thread row's `updated_at` (and reorders a two-thread `listThreads`); appending to a thread with no metadata row still persists the turn.
- [x] 2.2 `thread-store.test.ts`: no regression — `updateTitle` still bumps `updated_at`; `listThreads` ordering scenario extended to cover the append-driven reorder.

## 3. Verification

- [x] 3.1 `cd harness && bun test` + `bun run build`; run the package-boundary verify flow (harness:verify) against a real Postgres.
