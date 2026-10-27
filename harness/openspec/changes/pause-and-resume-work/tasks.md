# Tasks

## 1. The pause

- [x] 1.1 Add the table `cortex_paused_work` with a versioned migration (D6), with an index on the analysis and on the work id. Do a migration test.
- [x] 1.2 Add the pause module in `workflows/`. It holds the cause of a failure (D2), and the row and the part in steps. It also holds the wait on `DBOS.recv` with the topic of the pause, and the deadline of `retrying` from `DBOS.now()` (D1, D5). Remove `workflows/suspension.ts` and `cancelSelf`. Do DBOS tests: an outage goes to `paused` at the cap, a recovery keeps the deadline, and a restart returns to the same wait.
- [x] 1.3 Register `data-pause` as a reconciling part, keyed by the workflow id. Do a test of the fold.
- [x] 1.4 Set `enablePatching` in the SDK config of `launchDbos` (D13). Do a test of `dbosSdkConfig`. State in `CLAUDE.md` that a change of the operations of a workflow body uses `DBOS.patch`.

## 2. The loop

- [x] 2.1 Pause the loop at a failed request series in workflow code, and run the series again after the resume (D3). Keep a partial live reply as an interrupted reply, and append one harness request to continue. Do not pause outside a workflow or inside a step. Do DBOS tests: a resumed request sends the same messages, a partial reply continues, and a completed tool call does not run again.

## 3. The gates

- [x] 3.1 Pause at a refusal with the suspend flag of `RunCharge.open`, of the label gate of a spawn, and of `ArtifactRegistry.register` (D4). Call the gate again after the resume. Do a DBOS test for each gate.

## 4. The chat turn

- [x] 4.1 Read the credential before each model request, and pause with the cause `credential` when it is absent (D9). Make each later call use the credential that a resume puts. Remove the end `interrupted`, and give the failure codes `provider` and `internal`. Do DBOS tests: a recovery with no credential pauses, and a resume with a credential continues.
- [x] 4.2 Make the stop of a turn abort a wait in a pause, and delete the rows of the turn (D8). Do a test: a stopped paused turn closes as `aborted`, and the thread is free.

## 5. The run and the data profile

- [x] 5.1 Remove the suspended branch of the run: the status `suspended_insufficient_funds`, the topic `child-suspended`, the cancel of the siblings, `suspendAnalysis`, `resumeAnalysis`, the outcome `suspended` of `RunCharge.close`, and the revoke reasons (D10). Do DBOS tests: a paused step keeps its siblings and the run row `running`, and a resume completes the run.
- [x] 5.2 For a refused authorization with the suspend flag, fail the run row and do not mark the analysis. Do this in `execute_analysis` and in the launch of a stored plan. Do the same for the trigger of the data profile. Do a test for each.
- [x] 5.3 Pause the data profile in place, with the row `running` and no revoke (D4, D10). Do a DBOS test.
- [x] 5.4 Make the run canceler delete the rows of the pauses of the run. Do a test.
- [x] 5.5 Give `inspect_run` the state `paused` with the state and the cause of each waiting workflow, and make a wait return at a pause. Remove the suspended row of the run-event stream. Do tests.
- [x] 5.6 Add the migration that moves the old rows: a run `suspended_insufficient_funds` to `failed`, and an analysis to `active`. Do a migration test.

## 6. The host surface

- [x] 6.1 Give `CoreRuntime.pausedWork` with `list` and `resume` (D7), and the option `pauseRetryDelaysMs`. Put the credential of the session for a turn before the send. Remove the exports `suspensionOfFailure` and `Suspension`, and export the types of the surface. Do DBOS tests for these cases:
  - A resume ends each wait of a run.
  - A second resume does not end a later pause.
  - A list skips a row of an ended workflow.
  - Work of a different analysis gives `not_found`.

## 7. Documents and verification

- [x] 7.1 Update `CLAUDE.md`, `CONTEXT.md`, and `README.md` of the harness: the pause, the surface, and the removed suspension.
- [x] 7.2 Run the typecheck, the lint, the build, and the tests of the changed files. Run the full suite one time at the end.
