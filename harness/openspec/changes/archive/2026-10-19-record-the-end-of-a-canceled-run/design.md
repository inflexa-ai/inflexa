# Design

## Context

`createRunCanceler` (`src/execution/run-canceler.ts`) cancels the parent and the children. Then it converges the run row, the step rows, the charge, and the mandate. After the conditional terminal write wins, it records the run and step metrics (`transitioned`, and the `cutSteps` that it read after the engine cancel). It has no provenance dep.

The run emit is `ProvenanceSeam.emitRunEvent(event, session: RunSession)` (`src/provenance/seam.ts`). The body calls it through `emitProvenanceGuarded` (`src/workflows/execute-analysis.ts`), with the `RunSession` of its durable input and with `DBOS.now()` times. `RunAuthorizer.authorize` is the sole constructor of a `RunSession`. The canceler holds only the `AgentSession` of the cancel.

The cli change of the same name connects the `ProvenanceSeam` into the canceler of its cancel route.

## Goals / Non-Goals

**Goals:**

- A cancel that wins the run row records the end of the run and the end of each cut step through the run emit.
- A cancel that loses the run row, or that finds a terminal run, records nothing.

**Non-Goals:**

- A change to the workflow body, to `collectAndComplete`, or to the purge path. `purge-analysis` cancels through the purger directly and deletes the analysis.
- A record for a step that never started. The pending sweep marks it `skipped`, and the body also emits nothing for such a step.
- A change to `CancelRunResult`.

## Decisions

**The canceler takes the provenance seam, as each harness deps bag does.** `RunCancelerDeps` gets `provenance?: ProvenanceSeam`. The canceler reads `emitRunEvent` from it. A separate emit member for the canceler was rejected, because the provenance surface is one seam.

**The session parameter widens to `AgentSession`.** The user approved this. `RunCharge.close` is the precedent: it takes `AgentSession`, the body passes its `RunSession`, and the canceler passes the cancel session. A read of the `RunSession` from the durable input of the parent through the DBOS client was rejected: the repository has no host-side pattern for that read, and the canceler revokes that run credential in the same call.

**The emits ride behind `transitioned`, beside the metrics.** The metrics already use this condition for the same reason: a refused write means that the body settled the run and recorded its end. The emits come after the metrics, in the same block, before the step settle. The step events come first, and the run event comes last, which is the order of the body.

**One wall-clock read stamps each event of one cancel.** The canceler is not a workflow, thus no replay fires its emits again. `DBOS.now()` gives replay stability only inside a workflow, and the canceler works with no launched engine.

The conditional write lets one cancel win, thus each event fires at most one time. The read comes after the terminal write.

**The durations come from the row start times.** The canceler holds no `run_started` time. The run duration is `atMs` minus the `started_at` of the run row, not less than 0, which is the measure of the canceler metric. The harness writes that `started_at` as an ISO time at the launch (`src/state/runs.ts`), thus the canceler trusts it, and `run_completed.durationMs` stays required. The step duration is `elapsedSinceIso(step.startedAt, atMs)`. A step row can have no `started_at`, thus that duration can be absent, as the body already allows.

**A guard for each emit.** A throw of the realization goes to the log, as in `emitProvenanceGuarded`. A throw on one event does not skip the next event or a later phase. The canceler gets its own small guard, because `emitProvenanceGuarded` reads `ExecuteAnalysisDeps` and lives in the workflow module.

## Risks / Trade-offs

- [The run duration of the canceler starts at the launch of the run.] → It does not start at the `run_started` read of the body. Thus the span is a little longer than the span that the body measures. The record states a cancel, and the canceler metric uses the same span.
- [A cancel can land before the body emits `run_started`] → The document then holds a run activity with an end and no start. This is a true record of a run that the user canceled before it started.
- [The body and the canceler can both emit `run_completed` for one run.] → The body emits before its own status write, thus a cancel can win the row after the body emitted. The kernel keeps the last end record of a run (`PROV_UNIFY_OPTIONS`). In the usual order, the canceler emits last, thus the document says `canceled`, as the row does. Without this change, that document keeps the status of the body. The reverse order needs the terminal `DBOS.now()` step of the body to outlast the cancel, the read, and the write of the canceler. Then the document keeps the status of the body, as it does today.
- [A child in flight at the cancel can write its terminal row late.] → That write can come after the canceler emits. Then its step record says `canceled`, and its row records what the child did. The metric has the same limit.
- [A process can stop after the terminal write and before the emit.] → The end record is then lost. A second cancel finds a terminal run and emits nothing. The canceler metrics have the same limit, and the body records nothing for that run.
- [**BREAKING** for a realization that declares a `RunSession` parameter] → The cli realization reads only the event. No other realization exists in this repository.
