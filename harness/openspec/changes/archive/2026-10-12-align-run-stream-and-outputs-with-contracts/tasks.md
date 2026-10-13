# Tasks

The companion cli change `cli/openspec/changes/align-run-stream-and-outputs-with-contracts`
holds the cli tasks. Do the harness tasks first, because the cli build reads the
harness `dist/`.

## 1. A data part rides the run stream flat (issue item 1)

- [x] 1.1 Move the flatten of the `default` branch of `toChatFrame` into one exported function of `src/contracts/chat-frame.ts` that gives `{ ...data, type }` for a `ChatDataPart`. `toChatFrame` adds the source to its result. Make sure that the existing chat-frame tests pass.
- [x] 1.2 In the `emit` sink of `synthesizeFindings` (`src/workflows/execute-analysis.ts`), write each `ChatDataPart` through that function. Keep the `data-loop-event` envelope for the other events. Add a test that proves that a `data-run-synthesis` part reaches the run stream flat and passes `RunSynthesisPartSchema`, for example a conformance test in `src/workflows/execute-analysis.test.ts` whose run reaches a produced synthesis.
- [x] 1.3 Correct the comment of `parseRunEventPart` (`src/execution/run-event-parts.ts`): part schemas exist in `contracts/schemas/`. State the true reason for the check of the discriminant only. Make sure with `bun run lint` on the file.

## 2. Each file has the type of its folder (issue item 2)

- [x] 2.1 Change `inferArtifactType` (`src/schemas/artifact-manifest.ts`) to read a folder segment `figures`, `scripts`, `logs`, or `notebooks` at the start of the path or after a `/`. Add unit tests for the scenarios of the `artifact-manifest` delta: a top-level folder, a nested folder, a rooted path, and `figures_raw/x.png`.
- [x] 2.2 Remove the leading-slash prefix and its comment from `fallbackEntry` (`src/execution/artifact-metadata.ts`). Make sure that `src/execution/artifact-metadata.test.ts` passes.

## 3. A suspended run records a terminal status (issue item 3)

- [x] 3.1 Add a migration in `src/state/migrations/` whose name sorts after `20261012120000_index_the_runs_by_start`, and register it in `src/state/migrations/index.ts`. It drops `idx_cortex_runs_active_plan` if it exists and makes it again on `(analysis_id, plan_id) WHERE status = 'running'`. Do not change the baseline migration. Add the new name to the exact migration list of `src/state/thread-parent-columns.test.ts`. Add a database test that proves that a `running` row of a plan collides and that a `suspended_insufficient_funds` row of the same plan does not.
- [x] 3.2 In `src/state/runs.ts`, make `updateRunStatus` stamp `completed_at` for `suspended_insufficient_funds`. Make the active set `running` only in `queryActiveRun`, `queryActiveRunsByAnalysis`, `markRunCanceledIfActive`, `queryNonTerminalRunsByAnalysis`, and the order of `queryRunsForInspection` (running first, then each other run). Update the doc comments of these functions. Update `src/state/runs.test.ts` for the `run-state-persistence` delta scenarios.
- [x] 3.3 In `src/workflows/execute-analysis.ts`, make `deriveFinalStatus` give `suspended_insufficient_funds` for a suspension, and add the status to `ExecuteAnalysisFinalStatus`. Keep the charge-close outcome, the revoke reason, the analysis mark, the skipped sweep, and the self-cancel. Correct each comment that says a suspension writes `canceled`, for example the header and the sweep comment. Update the suspension tests of `src/workflows/execute-analysis.test.ts` and `src/workflows/__tests__/dbos/suspension-cascade.test.ts` to expect the new run status.
- [x] 3.4 In `src/tools/execute-analysis.ts`, write `suspended_insufficient_funds` for an authorization refusal with the suspend flag. Update `src/tools/execute-analysis.test.ts`.
- [x] 3.5 Add `suspended_insufficient_funds` to the terminal set of `src/execution/run-canceler.ts`, so a cancel of a suspended run gives `already_terminal`. Update `src/execution/run-canceler.test.ts` for the `run-cancellation` delta scenario.
- [x] 3.6 Add the status to `RunOutcome` in `src/lib/metrics.ts`. Correct the comment of the `run_completed` status in `src/provenance/seam.ts`. Add the status to `ProvRunOutcome.status` in `prov-kernel/src/types.ts` and correct its comment. In `prov-kernel/`, run `bun run typecheck`, `bun run lint`, `bun test`, and `bun run build && bun run smoke`.
- [x] 3.7 In `src/tools/research/inspect-run.ts`, treat `suspended_insufficient_funds` as terminal for the path exposure. Keep the targeted state `suspended`, with a message that the host suspended the run and that a new run of the plan can start. Correct the tool description text of the list order and of the `suspended` state. Update `src/tools/research/misc-tools.test.ts` for the `run-inspection` delta scenarios.
- [x] 3.8 In `src/app/run-activity.ts`, list the running runs only, and make the empty text say that no runs are currently running. Update `src/app/run-activity.test.ts` and `src/app/chat-turn.test.ts` for the `conversation-run-awareness` delta scenarios.

## 4. Each run with a run row ends with a terminal part (issue item 4)

- [x] 4.1 In `src/execution/run-event-stream.ts`, add the dependency `readWorkflowStatus` (default: the status of `DBOS.getWorkflowStatus`, or `null` when no workflow exists). Replace the canceled-only terminal part with the mapping of the `run-event-stream` delta: from the run row, and from the workflow status when the row still reads `running` after the last read. The re-read set is `running` only. Update the doc comment of `RunEventStream.subscribe`.
- [x] 4.2 Add tests to `src/execution/run-event-stream.test.ts` for each scenario of the delta requirement "A run with a run row ends with a terminal part". Change the test "adds no part when the row stays active past the last read" to give an active workflow status, and add the `ERROR`, `CANCELLED`, and no-workflow cases. Add the `completed` and `partial` rows that get no part.

## 5. Verify the harness

- [x] 5.1 Run `bun run format:file` on each changed file in `src/` of the harness and of `prov-kernel`. Run the harness `tsc -p tsconfig.build.json` and `bun run lint`.
- [x] 5.2 Run the changed harness test files with `bun run test:full <files>` from `harness/`, and make sure that each passes.
