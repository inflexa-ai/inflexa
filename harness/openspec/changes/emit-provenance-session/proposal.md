# Deliver the run session through the provenance seam

## Why

The realization of the `emitProvenance` seam must persist each observation to an external store. That write is an authenticated wire call, and the call requires three things: the authority of the run's credential, the scope of the organization and the resource, and the acting identity. All three live on the `RunSession` that the workflow bodies already carry in their durable input.

Today the seam hands over only the event. A host that must persist it has to reconstruct the session out of band, through fragile adoption protocols keyed on the calls of other seams. That reconstruction is a guess about which session a run rides, and the guess breaks whenever the other seam's call order moves.

Every other harness seam whose realization makes an authenticated wire call already receives a session: `ChatProvider`, `EmbeddingProvider`, and `ArtifactRegistry.register`. This change makes `emitProvenance` consistent with them.

## What Changes

- `emitProvenance` on `ExecuteAnalysisDeps` widens to `(event: RunProvenanceEvent, session: RunSession) => void`. Every emit site passes the `RunSession` from the durable workflow input. Fire-and-forget semantics and the checkpointed timestamps are unchanged. An implementation MAY ignore the parameter, so an existing realization that reads only the event stays correct as written.

## Capabilities

### Modified Capabilities

- `run-observation-seam`: the provenance seam delivers each event together with the run session from durable workflow input.

## Impact

Harness source:

- `src/workflows/execute-analysis.ts` — the widened seam signature, the guarded invoker, and the three emit sites (`run_started`, `step_completed`, `run_completed`).

Consumers: the change is additive. A widened optional-callback parameter is type-compatible for every existing implementation.
