# Tasks: synthesis-step-ledger-row

## 1. Reserved step id

- [x] 1.1 Extend `RESERVED_STEP_IDS` in `src/schemas/validate-plan.ts` to include `synthesis` alongside `STEP_SUBDIRS`, and update the validation error message to name both collision reasons (artifact-subdir convention; the run-phase ledger row and `runs/{runId}/synthesis.json`)
- [x] 1.2 Extend `src/schemas/validate-plan.test.ts` with `synthesis` / `SYNTHESIS` rejection cases (mirror the existing reserved-name test shape)

## 2. Seed the synthesis row

- [x] 2.1 In `runExecuteAnalysisBody` (`src/workflows/execute-analysis.ts`), append a `synthesis` row (`stepId: "synthesis"`, `agentId: "run-synthesizer"`, `wave: max DAG level + 1`) to the existing `seed-step-executions` row array, gated on `deps.synthesisEnabled ?? true` — comment why the gate is enablement-only (the `completed.size > 0` half of the run gate is unknowable at seed time; the sweep finalizes a gate-failed row to `skipped`)
- [x] 2.2 Hoist the synthesis agent id and reserved step id into named constants shared by the seed, the transitions, and (for the id) `validate-plan.ts`, so the reserved identity has one definition

## 3. Transition the row around synthesize-findings

- [x] 3.1 Immediately before the `synthesize-findings` step, inside the existing `synthesisEnabled && final.completed.size > 0` gate: bracket with a checkpointed `DBOS.now()` read and mark the row running via `insertStepExecution` (`childWorkflowId: null`) in a named `DBOS.runStep`, log-don't-fail
- [x] 3.2 On the success path, map the resolved outcome to the row's terminal status via `updateStepExecution` in a named `DBOS.runStep` — `produced` → `completed`, `skipped_no_summaries` → `skipped`, `skipped_blocker` → `blocked` + `blockedReason`; stamp `durationMs` from the `DBOS.now()` bracket; log-don't-fail
- [x] 3.3 In the existing synthesis `catch`, stamp the row `failed` with `error` = the same reason string recorded to `cortex_runs.synthesis_reason`, before control reaches `collectAndComplete` — so the row is terminal before the run row is
- [x] 3.4 Verify (and comment) that both transition steps sit strictly before `collectAndComplete` on every path, so no reader can observe a terminal run row beside a `running` synthesis row
- [x] 3.5 Guard the synthesis `catch` with `if (err instanceof DBOSErrors.DBOSWorkflowCancelledError) throw err;` before any classification (the `sandbox-step.ts:513` rule), with a comment stating why cancellation is not a synthesis outcome and why the row is deliberately left as-is (design D7)

## 4. Tests

- [x] 4.1 Seed: with synthesis enabled, `queryStepsByRun` returns DAG rows + a `pending` `synthesis` row ordered last; with `synthesisEnabled: false`, no synthesis row exists (extend `execute-analysis.test.ts` using its existing seed/ledger test rig)
- [x] 4.2 Transitions: drive the parent body through a completing run and assert the row's `running` → `completed` states and `started_at`/`completed_at`/`duration_ms` stamps; for the write-ordering claim, wrap the injected test pool so that when the terminal UPDATE for `step_id = 'synthesis'` executes it snapshots `cortex_runs.status`, and assert that snapshot reads `running` — a state-at-a-point-in-time assertion through the pool seam, not a call-count mock
- [x] 4.3 Outcome mapping: one case per terminal — produced → completed; skipped_no_summaries → skipped; blocker → blocked with `blocked_reason`; thrown → failed with `error` populated and the run failed; a thrown `DBOSWorkflowCancelledError` → re-propagates with the row untouched (still `running`) and no synthesis outcome persisted
- [x] 4.4 Gate-never-passes: synthesis enabled but zero completed steps → row swept to `skipped` at finalisation; budget-pause path leaves the already-terminal synthesis row untouched
- [x] 4.5 Replay: re-running the seed against an advanced row does not reset it (DO NOTHING contract holds for the synthesis row)

## 5. Verify and close out

- [x] 5.1 `tsc -p tsconfig.json` and `bun test` clean in `harness/`; `bun run format:file` on touched `src/` files
- [x] 5.2 Confirm the consumer surfaces render the row with zero changes: `cli` typecheck/tests still pass against the updated harness (`stepStateOf` and `inflexa run` already handle every status the row uses); note in the PR that denominators become N+1 by design
- [x] 5.4 `inspect_run` must not emit a per-step `summaryPath` for the reserved `synthesis` row (it has no `{stepId}/output/summary.md`; its product is the run-level `synthesis.json`) — gate the path on the reserved id, with a test
- [x] 5.3 Update `openspec/specs/` via archive flow when done (`/opsx:verify` then `/opsx:archive`)
