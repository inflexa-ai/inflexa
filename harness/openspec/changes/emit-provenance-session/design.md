# Design — provenance events ride with the run session

## Context

`emitProvenance` is the optional, fire-and-forget run-lifecycle observation on `ExecuteAnalysisDeps` (`src/workflows/execute-analysis.ts`). Its events exist to close an external provenance record, and the realization that closes one makes an authenticated wire call. The workflow bodies carry a `RunSession` in their durable input (`input.runSession`), minted once at the async edge by the `RunAuthorizer` seam and reconstructed by DBOS replay from the serialized input. The seam, however, delivered only the event — the one payload a persisting realization cannot act on alone.

## Decisions

**D1 — The session is a seam parameter, not a host-side reconstruction.** The alternative — a host that adopts the session from another seam's call (the run charge's `open`, the authorizer's `authorize`) and correlates it to provenance events by run id — was rejected. That protocol couples the provenance realization to the call order of unrelated seams, breaks silently when a run recovers on a replica that never saw the correlated call, and re-derives a value the durable input already holds. The body passes `input.runSession` at each emit site: the same object DBOS replay reconstructs, so a re-fired emission carries the identical session. This is the established pattern for every seam whose realization makes an authenticated wire call (`ChatProvider`, `EmbeddingProvider`, `ArtifactRegistry.register`).

**D2 — The parameter is `RunSession`, not `AgentSession`.** The seam exists only inside workflow bodies, and a durable body carries only a `RunSession`. The wider `AgentSession` would admit a `RequestSession`, which must never be JSON-serialized into durable state — a type that permits it here would misstate where the seam can fire. The narrowness is the contract.

**D3 — Implementations MAY ignore the parameter.** Widening an optional callback's parameter list is type-compatible for every existing implementation (a function that takes fewer parameters is assignable), so the seam widens without a breaking version. A realization with no external store simply never reads the session.

**D4 — No data-profile arm.** The profile produces no lineage-tracked content: its outputs (the ledger row, `profile-summary.md`, the vector index entries) are reproducible derived metadata, unregistered as artifacts and absent from any lineage surface. An observation with no consumer is vocabulary for its own sake; a profile arm returns when a consumer exists.

## Non-Goals

- No change to fire-and-forget semantics, the checkpointed timestamps, or the replay behavior of the existing arms.
- No data-profile provenance (D4).
- No change to `observeRun` — the two seams stay independent, per the existing requirement.
