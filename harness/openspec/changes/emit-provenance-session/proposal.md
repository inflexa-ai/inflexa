# Deliver the run session through the provenance seam

## Why

The realization of the `emitProvenance` seam must persist each observation to an external store. That write is an authenticated wire call, and the call requires three things: the authority of the run's credential, the scope of the organization and the resource, and the acting identity. All three live on the `RunSession` that the workflow bodies already carry in their durable input.

Today the seam hands over only the event. A host that must persist it has to reconstruct the session out of band, through fragile adoption protocols keyed on the calls of other seams. That reconstruction is a guess about which session a run rides, and the guess breaks whenever the other seam's call order moves.

Every other harness seam whose realization makes an authenticated wire call already receives a session: `ChatProvider`, `EmbeddingProvider`, and `ArtifactRegistry.register`. This change makes `emitProvenance` consistent with them.

The data-profile workflow has the same defect in a stronger form: it exposes no provenance hook at all, so a host cannot observe a profile's terminal outcome through the seam that observes every other durable outcome.

## What Changes

- `emitProvenance` on `ExecuteAnalysisDeps` widens to `(event: RunProvenanceEvent, session: RunSession) => void`. Every emit site passes the `RunSession` from the durable workflow input. Fire-and-forget semantics and the checkpointed timestamps are unchanged. An implementation MAY ignore the parameter, so an existing realization that reads only the event stays correct as written.
- `DataProfileDeps` gains the same optional `emitProvenance`, and `RunProvenanceEvent` gains a `data_profile_completed` arm (`analysisId`, terminal `status`, checkpointed `atMs`, `durationMs`). The profile body emits it on both terminal paths — completion and failure — with the session from its durable input. There is deliberately no `data_profile_started` arm (see the design).

## Capabilities

### Modified Capabilities

- `run-observation-seam`: the provenance seam delivers each event together with the run session from durable workflow input, and the data-profile workflow reports its terminal observation through the same seam.

## Impact

Harness source:

- `src/workflows/execute-analysis.ts` — the widened seam signature, the guarded invoker, the three emit sites (`run_started`, `step_completed`, `run_completed`), and the new union arm.
- `src/tasks/data-profile.ts` — the new optional dep, its guarded invoker, and the terminal emissions on the completion and failure paths.

Consumers: the change is additive. A widened optional-callback parameter is type-compatible for every existing implementation, and the new union arm extends a union consumers already discriminate on `type`.
