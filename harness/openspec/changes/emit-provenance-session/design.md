# Design — provenance events ride with the run session

## Context

`emitProvenance` is the optional, fire-and-forget run-lifecycle observation on `ExecuteAnalysisDeps` (`src/workflows/execute-analysis.ts`). Its events exist to close an external provenance record, and the realization that closes one makes an authenticated wire call. The workflow bodies carry a `RunSession` in their durable input (`input.runSession`), minted once at the async edge by the `RunAuthorizer` seam and reconstructed by DBOS replay from the serialized input. The seam, however, delivered only the event — the one payload a persisting realization cannot act on alone.

The data-profile workflow (`src/tasks/data-profile.ts`) carries the same durable session in `DataProfileWorkflowInput.runSession` and exposed no provenance hook at all.

## Decisions

**D1 — The session is a seam parameter, not a host-side reconstruction.** The alternative — a host that adopts the session from another seam's call (the run charge's `open`, the authorizer's `authorize`) and correlates it to provenance events by run id — was rejected. That protocol couples the provenance realization to the call order of unrelated seams, breaks silently when a run recovers on a replica that never saw the correlated call, and re-derives a value the durable input already holds. The body passes `input.runSession` at each emit site: the same object DBOS replay reconstructs, so a re-fired emission carries the identical session. This is the established pattern for every seam whose realization makes an authenticated wire call (`ChatProvider`, `EmbeddingProvider`, `ArtifactRegistry.register`).

**D2 — The parameter is `RunSession`, not `AgentSession`.** The seam exists only inside workflow bodies, and a durable body carries only a `RunSession`. The wider `AgentSession` would admit a `RequestSession`, which must never be JSON-serialized into durable state — a type that permits it here would misstate where the seam can fire. The narrowness is the contract.

**D3 — Implementations MAY ignore the parameter.** Widening an optional callback's parameter list is type-compatible for every existing implementation (a function that takes fewer parameters is assignable), so the seam widens without a breaking version. A realization with no external store simply never reads the session.

**D4 — `data_profile_completed`, with no started arm.** Completion is the observation that matters: the profile's durable products (the ledger row, the vector index) exist only at its terminal boundary, and the terminal event's `durationMs` — a terminal `DBOS.now()` read minus a body-start read, both checkpointed and replay-stable — already carries the span a started arm would add. A started arm would double the emission surface for an observation no consumer needs. The arm carries `analysisId` and no `runId`, because a profile runs under the constant synthetic frame and the run id identifies nothing.

**D5 — The profile's terminal emission sits after every operation that can throw.** The emission follows the terminal ledger write and the authorization revoke on each path, immediately before the activity terminal — the same exactly-one-terminal discipline the profile's activity emitter documents. Emitted earlier, a failing ledger write would produce a `completed` event for a profile that then lands `failed`. Both terminal paths emit, with the honest status; the invoker is guarded, so a throwing observer never fails the profile.

## Non-Goals

- No change to fire-and-forget semantics, the checkpointed timestamps, or the replay behavior of the existing arms.
- No `data_profile_started` arm (D4).
- No change to `observeRun` — the two seams stay independent, per the existing requirement.
