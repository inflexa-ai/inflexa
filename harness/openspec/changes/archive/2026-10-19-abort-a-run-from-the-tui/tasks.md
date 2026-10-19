# Tasks

## 1. Harness: settle the cut steps of a canceled run

- [x] 1.1 Add `cancelRunningStepExecutions(pool, runId, reason)` to `src/state/step-executions.ts`: one conditional `UPDATE` of the run's `running` rows to `canceled`, with `completed_at`, `duration_ms` from `started_at` (NULL when `started_at` is NULL), and `error` = `reason`. Add a Postgres test in `src/state/step-executions.test.ts` for the scenario "The running settle touches only running rows", and make sure that it passes under `bun run test:full src/state/step-executions.test.ts`.
- [x] 1.2 In `src/execution/run-canceler.ts`, make the step phase run the pending sweep and then the running settle with `EXTERNAL_CANCEL_REASON`, each in its own `try`. Set `converged.steps` to true only when both succeed. Make sure that the `bun test src/execution/run-canceler.test.ts` suite passes.
- [x] 1.3 Extend the in-memory pool fake of `src/execution/run-canceler.test.ts` to answer the new statement with its `status = 'running'` guard. Add tests for the scenarios "A step cut mid-flight settles as canceled", "A step that settled first keeps its status", and "A failed step write does not skip the other". Make sure that each new test passes.
- [x] 1.4 Run `bun run format:file` on the changed source files, then `npm run typecheck` and `npm run lint` in `harness/`. Make sure that they pass.
