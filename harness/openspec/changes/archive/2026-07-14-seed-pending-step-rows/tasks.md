## 1. Ledger helpers

- [x] 1.1 Add `seedStepExecutions(pool, rows)` to `src/state/step-executions.ts`: one multi-row INSERT with `status='pending'`, `started_at=NULL`, `ON CONFLICT (run_id, step_id) DO NOTHING`; rows carry `{runId, stepId, analysisId, wave, agentId}`; returns `ResultAsync<void, DbError>`
- [x] 1.2 Change `queryStepsByRun` ordering to `ORDER BY wave, started_at NULLS LAST, step_id`
- [x] 1.3 Extend `src/state/step-executions.test.ts`: seed idempotence (DO NOTHING against an advanced row), seeded-pending → mark-running flip via `insertStepExecution`, and the wave/NULLS-LAST/step_id ordering

## 2. executeAnalysis wiring

- [x] 2.1 In `runExecuteAnalysisBody` (`src/workflows/execute-analysis.ts`), add a named durable step after `validateAndInit` (beside the `data-run-started` emit) that calls `seedStepExecutions` for every plan step, with `wave` from `computeTopologicalLevels` and `agent_id` from `input.agentByStepId` (verify plan validation already guarantees an assignment per step — no invented fallback)
- [x] 2.2 In `collectAndComplete`, add a named durable sweep step (`pending → skipped`, `completed_at` stamped) on the genuinely-terminal branch only — structurally excluded on the resumable 402 budget-pause branch (which also writes run status `"canceled"`, so the gate must be the branch, not the status); log-don't-rollback on sweep failure, matching the hook's rule
- [x] 2.3 Survey in-repo `queryStepsByRun` consumers for "row exists ⇒ step ran" assumptions (`tools/research/inspect-run.ts` wording, budget-cascade test fixtures) and adjust where misleading

## 3. Tests & verification

- [x] 3.1 Two-layer coverage instead of a new DBOS rig (the existing rig test drives synthetic children, not the real parent body+pool, and a new rig would only re-test DBOS step caching): real-Postgres semantics in `step-executions.test.ts` (seed nulls, DO NOTHING replay, pending→running flip, ordering) + body-level tests in `execute-analysis.test.ts` (seed fires once with all steps/waves, fail-fast sweeps to `skipped`)
- [x] 3.2 Budget-pause body test: the 402 pause branch issues NO sweep (pending rows preserved for resume); resume-path replay safety is carried by the seed's DO NOTHING semantics (tested on real Postgres) plus the existing cascade rig's step-cache assertions
- [x] 3.3 Run `tsc -p tsconfig.json` and `bun test`; `bun run format:file` on touched files
