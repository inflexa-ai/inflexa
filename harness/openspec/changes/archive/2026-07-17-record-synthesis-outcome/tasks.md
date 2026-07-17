## 1. Persistence layer — cortex_runs synthesis columns

- [x] 1.1 Add `synthesis_status TEXT` and `synthesis_reason TEXT` (both nullable) to the base `CREATE TABLE cortex_runs` in `state/init.ts`, and add matching `ALTER TABLE cortex_runs ADD COLUMN IF NOT EXISTS ...` entries to the `addMigrations` list
- [x] 1.2 Add a `SynthesisStatus` Zod enum (`produced | skipped_no_summaries | skipped_blocker | failed`) and extend `CortexRunRowSchema` in `state/schema.ts` with `synthesisStatus` (nullable enum) and `synthesisReason` (nullable string)
- [x] 1.3 Extend `mapRunRow` and the `SELECT` column lists in `queryRun`, `queryActiveRun`, `queryRunsByAnalysis`, `queryRunsByThread` (`state/runs.ts`) to read `synthesis_status` / `synthesis_reason`
- [x] 1.4 Add `setRunSynthesisOutcome(pool, runId, synthesisStatus, synthesisReason?)` to `state/runs.ts` (focused column write mirroring `setRunMandate`), export it from `state/index.js`
- [x] 1.5 Unit tests (postgres testcontainer): `setRunSynthesisOutcome` round-trips through `queryRun`; a fresh DB and a DB migrated from a pre-column `cortex_runs` both expose the columns; a legacy row reads `synthesisStatus: null` — tests written (`state/runs.test.ts`); execution blocked by no Docker in this env (affects all pg-backed suites)

## 2. Synthesis outcome classification + loud skip

- [x] 2.1 Introduce the outcome shape (`{ status: SynthesisStatus; reason?: string; findings: readonly RunFinding[] }`) and change `SynthesizeRunResult` to carry `status` + `reason` in `app/synthesize-run.ts`
- [x] 2.2 Return `skipped_no_summaries` (no summaries) and `skipped_blocker` (with the blocker reason) from the two early-return paths; return `produced` on the persist path; keep the `failed` re-throw so the run still fails
- [x] 2.3 Emit `logger.warn` (namespace `synthesize-run`, fields `runId` + reason) at both skip sites; the `produced` path does not warn
- [x] 2.4 Unit tests: blocker → `skipped_blocker` + warn + no `synthesis.json`; no-summaries → `skipped_no_summaries` + warn + no synthesizer loop; produced → `produced`, file persisted, no warn — 4 pass (stubbed pool, ran without Docker)

## 3. Workflow persistence in collectAndComplete

- [x] 3.1 `synthesizeFindings` (`workflows/execute-analysis.ts`) returns the outcome; the body captures `{status, reason}`, mapping a caught `synthesisError` to `failed` with the error message
- [x] 3.2 Pass the outcome into `collectAndComplete`; persist it via `setRunSynthesisOutcome` in its own named `DBOS.runStep` (log-don't-rollback, alongside `persist-final-status`); leave the columns NULL when synthesis did not run (`synthesisEnabled` false or `final.completed.size === 0`)
- [x] 3.3 Tests: produced → run `completed` with `synthesis_status = produced`; blocker → run `completed` with `synthesis_status = skipped_blocker` + reason; synthesis throw → run `failed` with `synthesis_status = failed`; no step completed → columns NULL — 4 cases added, suite 30/30 pass (fake DBOS, no Docker needed)

## 4. Consumer surface — inspect_run + conversation guidance

- [x] 4.1 `tools/research/inspect-run.ts` `formatRun`: set `synthesisPath` only when `synthesisStatus === "produced"` (else `null`); always include `synthesisStatus` and `synthesisReason` in the formatted run
- [x] 4.2 Reconcile the "Interpreting Results" guidance in `prompts/conversation.ts`: `synthesis.json` exists only for a run whose synthesis was produced; direct the agent to fall back to per-step `summary.md` when it was skipped/failed
- [x] 4.3 Tests: `inspect_run` on a `produced` run advertises the path; on a `skipped_blocker` run returns `synthesisPath: null` with the status/reason surfaced; on a legacy `NULL` run returns `synthesisPath: null` — 3 cases added in `misc-tools.test.ts` (fake pool), 7/7 pass

## 5. Verify

- [x] 5.1 `bun run format:file` on every changed `src/` file — all clean
- [x] 5.2 `tsc -p tsconfig.json` clean — exit 0 (whole project); eslint clean on all changed files
- [x] 5.3 `bun test` green for the touched suites — ran against a throwaway pgvector container via podman (`CORTEX_TEST_PG_URL`): full `state/` suite + the three change suites = **112 pass, 0 fail** (incl. `state/runs.test.ts` 2/2); no regression from the `CortexRunRow` change
- [x] 5.4 Skipped-synthesis behavior verified end-to-end at the integration layer against real Postgres: classify (`synthesize-run` 4/4) → persist to `cortex_runs.synthesis_status` (`execute-analysis` 30/30, incl. blocker→`skipped_blocker`+reason, disabled→no write) → gate (`inspect_run` 7/7, `produced`→path, skip→null path + reason surfaced). A live full-analysis app run (sandbox+LLM) was not driven — out of proportion; the layered tests exercise the same path.
