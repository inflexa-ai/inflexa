# Record the end of a canceled run

## Why

A run that a user aborts from the TUI (issue #250) has no end in the signed provenance document. The cancel route builds the harness run canceler with no `ProvenanceSeam`, and the body of a canceled run never reaches its own end emit.

The same gap holds a model switch. The agent switch tracks a run as work in progress from `prov.run_started` to `prov.run_completed`. An aborted run never gets `prov.run_completed`, thus a model selection that waits for idle never applies until the process restarts.

## What Changes

- The cancel route builds its run canceler with the installed `ProvenanceSeam`. The harness change of the same name makes the canceler emit the end events through it.
- An aborted run then gets `prov.step_completed` with the status `canceled` for each cut step, and `prov.run_completed` with the status `canceled`. The recorder signs them into the document of the analysis. The agent switch and the activity time see the same `prov.run_completed`.
- The run emit of the harness takes an `AgentSession`. The cli realization reads only the event, thus it does not change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `prov-harness-bridge`: the run emit takes an `AgentSession` and has a second emit site, the run canceler. The cancel route gives the installed `ProvenanceSeam` to its canceler.
- `prov-run-events`: the timestamps of the end events of a canceled run come from one wall-clock read of the canceler.

## Impact

- `src/server/routes/runs.ts`: a named builder makes the deps of the production canceler, with `provenance: provenanceSeam()`.
- Tests: `src/server/routes/runs.test.ts` for the deps of the production canceler.
- The harness change of the same name changes `ProvenanceSeam` and `RunCancelerDeps`. The cli links the working copy of the harness.
