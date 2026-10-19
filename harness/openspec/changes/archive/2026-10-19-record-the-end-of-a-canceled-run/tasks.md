# Tasks

## 1. Harness: the run emit takes an `AgentSession`

- [x] 1.1 In `src/provenance/seam.ts`, change the session parameter of `emitRunEvent` to `AgentSession`. Update the document comments of `RunProvenanceEvent` and `emitRunEvent`: the body reads `DBOS.now()`, and the run canceler reads the wall clock one time, because no replay fires its emits. Name the canceler as the second emit site of `step_completed` and `run_completed`. Make sure that `npm run typecheck` passes in `harness/`.
- [x] 1.2 In `src/workflows/execute-analysis.test.ts`, change the session type of the `emitRunEvent` option of the test helper to `AgentSession`, if the typecheck needs it. Make sure that `bun test src/workflows/execute-analysis.test.ts` passes with no other change to the body.

## 2. Harness: the canceler records the end of the run

- [x] 2.1 In `src/execution/run-canceler.ts`, add `provenance?: ProvenanceSeam` to `RunCancelerDeps`. In the `transitioned` block, after the metrics, read `Date.now()` one time. Emit `step_completed` with the status `canceled` for each step of `cutSteps`, then `run_completed` with the status `canceled`. Pass the `session` of `cancel` to each emit. For the run, set `durationMs` to `Math.max(0, atMs - Date.parse(row.startedAt))`. For each cut step, use `elapsedSinceIso(step.startedAt, atMs)`, and omit the field when it gives `undefined`. Guard each emit, so that a throw goes to the log and skips nothing. Make sure that `npm run typecheck` passes.
- [x] 2.2 In `src/execution/run-canceler.test.ts`, add a test for each scenario of the requirement "The canceler records the end of the run that it cancels". These are the scenarios:
  - a won cancel with a cut step: the order of the events, the session object, one `atMs`, and the durations
  - a concurrent completion
  - a second cancel
  - a failed read of the cut steps
  - a throwing run emit: the convergence and the result do not change
  - no bound run emit.

  Assert on the received events and the result. Make sure that `bun test src/execution/run-canceler.test.ts` passes.

## 3. Verification

- [x] 3.1 Run `bun run format:file` on each changed file in `src/`, then `npm run typecheck` and `npm run lint` in `harness/`. Make sure that they pass.
- [x] 3.2 Run `npm run build` in `harness/`, so that the cli, which links this working copy, sees the new types. Make sure that the build passes.
