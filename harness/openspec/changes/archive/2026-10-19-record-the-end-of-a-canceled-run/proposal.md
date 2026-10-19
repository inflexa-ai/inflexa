# Record the end of a canceled run

## Why

An external cancel stops the body of the run, thus `collectAndComplete` does not run and emits no `run_completed`. The run canceler converges the ledgers, but it emits no provenance. Thus each run that a user aborts from the TUI (issue #250) has no end. The signed provenance document keeps a run activity with a start time and no end time.

The cli also uses the run end to know when a run stops. Its agent switch keeps an aborted run as work in progress, thus a model switch that waits for idle never applies until the process restarts.

## What Changes

- The run canceler takes the optional `ProvenanceSeam` of the harness. When its conditional terminal write wins, it emits `step_completed` with the status `canceled` for each step that the cancel cut. Then it emits `run_completed` with the status `canceled`.
- The canceler reads the wall clock one time for these emits. It is not a workflow, thus no replay fires the emits again. The run duration comes from the start time of the run row. The step duration comes from the start time of each step row.
- **BREAKING**: the session parameter of `ProvenanceSeam.emitRunEvent` changes from `RunSession` to `AgentSession`. The body continues to pass the `RunSession` of its durable input. The canceler passes the session of the cancel. A realization that declares a `RunSession` parameter no longer typechecks.
- A refused terminal write emits nothing, because the run ended by itself and its body recorded the end.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `run-cancellation`: the canceler records the end of the run that it cancels, and the end of each cut step.
- `provenance-seam`: the run emit takes an `AgentSession`, and it has a second emit site outside a workflow body.
- `run-observation-seam`: the session rule of the run emit names the session of each emit site.

## Impact

- `src/provenance/seam.ts`: the session parameter of `emitRunEvent`, and the document comment of the clock and the emit sites.
- `src/execution/run-canceler.ts`: the optional `provenance` dep and the guarded emits.
- `src/workflows/execute-analysis.ts`: no behavior change. The body passes its `RunSession` to the wider parameter.
- Tests: `src/execution/run-canceler.test.ts` (in-memory pool fake), and the session type of the emit helper in `src/workflows/execute-analysis.test.ts`.
- The public barrel exports `RunCancelerDeps` and `ProvenanceSeam`. Both change shape. The cli change of the same name connects the seam into the canceler of its cancel route.
