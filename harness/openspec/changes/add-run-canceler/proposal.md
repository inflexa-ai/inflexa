# Expose a fully encapsulated run canceler

## Why

External cancellation of an `executeAnalysis` run converges nothing today. A cancelled DBOS workflow can never execute another step, so `collectAndComplete` — the one block that finalises run-level state — is unreachable on that path (the wedge is documented beside the external-cancellation catch in `src/workflows/execute-analysis.ts`). A host that calls `DBOS.cancelWorkflow` is left holding the pieces: the `cortex_runs` row stays `running` forever (which blocks same-plan relaunch through `queryActiveRun`'s active-status dedup), pending `cortex_step_executions` rows never sweep, the running charge never closes, and the run mandate is never revoked. Every embedder would have to hand-roll the same four-way convergence against ledgers the harness owns.

## What Changes

- New `createRunCanceler(deps)` execution module: cancels the DBOS parent workflow and its children (child-cascading, plus the persisted child ids and one re-query for late-committing children), then converges the run row, the pending step rows, the running charge, and the run mandate — each phase isolated so one failure does not skip the rest. Returns a `CancelRunResult` reporting the outcome and per-phase convergence flags. Idempotent: a second cancel of a terminal run short-circuits to `already_terminal` with no engine call.
- New `markRunCanceledIfActive(pool, runId, reason)` state accessor: a conditional terminal write that transitions only an active run to `canceled` and reports whether a row transitioned, so an external cancel racing a concurrently-completing run never clobbers the workflow's own terminal status.
- `RunAuthorizer` gains a required `revokeByJti(ref, reason)` method for out-of-band revocation where only the persisted jti exists (the mandate JWT is never persisted). **BREAKING** for embedder-supplied authorizers: the interface grows a required method. The local/OSS realization no-ops (it mints no jti).
- Barrel exports for `createRunCanceler`, `RunCanceler`, `CancelRunResult`, and `markRunCanceledIfActive`.

## Capabilities

### New Capabilities

- `run-cancellation`: the encapsulated external-cancel path — engine cancellation reach (parent, children, late-committing children), the four convergence phases and their isolation, idempotency, and the result contract.

### Modified Capabilities

- `run-state-persistence`: adds the conditional `markRunCanceledIfActive` terminal write beside the unconditional `updateRunStatus`.
- `harness-session-model`: the `RunAuthorizer` seam gains the required out-of-band `revokeByJti`, distinct from the terminal-path `revoke` that runs under the run credential.

## Impact

Harness source:

- `src/state/runs.ts` — `markRunCanceledIfActive`.
- `src/execution/run-canceler.ts` (new) — `createRunCanceler`, `RunCanceler`, `CancelRunResult`.
- `src/execution/run-authorizer.ts` — `revokeByJti` on the seam.
- `src/auth/local-run-authorizer.ts` — no-op `revokeByJti`.
- `src/index.ts` — barrel exports.

Consumers: managed hosts (Cortex) replace their hand-rolled cancel route body with `runCanceler.cancel(runId, session)` and realize `revokeByJti` in their authorizer. The cli's local authorizer comes from the harness factory and needs no change; embedder test fakes typed as `RunAuthorizer` must add the no-op method.

Out of scope: read-side synthesis of the terminal stream frame (`DBOS.writeStream` is body-only — hosts own that), and the workflow-body terminal path itself, which is unchanged.
