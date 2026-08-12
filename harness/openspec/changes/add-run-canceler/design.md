# Run canceler design

## Context

`executeAnalysis` finalises run-level state in `collectAndComplete`, which a cancelled DBOS workflow can never reach — a cancelled workflow cannot execute steps. External cancel therefore needs a second, host-side convergence path over the same ledgers: run row, step rows, running charge, run mandate. Cortex hand-rolls a partial version today (engine cancel only, no convergence); the harness owns every ledger involved, so the whole path belongs here.

## Goals / Non-Goals

**Goals:**

- One call a host makes from its cancel route that leaves the run ledger, step ledger, charge bracket, and mandate in the states the workflow's own terminal path would have produced.
- Safe against the two known races: a run completing concurrently with the cancel, and a child workflow whose `mark-running` step has not yet committed its `child_workflow_id`.
- Honest reporting: per-phase convergence flags, never a claimed convergence that did not happen.

**Non-Goals:**

- Terminal stream frames — `DBOS.writeStream` is body-only; hosts synthesize the terminal frame read-side.
- Changing the workflow body's own terminal path or the budget-pause branch.
- Resume of cancelled runs.

## Decisions

**Engine cancel via `DBOSClient`, reusing the purger's realization.** `createDbosWorkflowPurger({pool}).cancel` already does exactly the required engine call — `client.cancelWorkflows(ids, { cancelChildren: true })` over an injected pool, no launched engine required, ledger-absent recovery included. The canceler defaults its internal `cancelWorkflows` seam to it rather than duplicating a second `DBOSClient` construction. The static `DBOS` facade was rejected for the same reason it was rejected for the purger: it throws without a launched engine, and an embedder's host copy of the SDK may be a different, un-launched instance. The seam is an optional dep with this production default (the BillingFetcher pattern) so unit tests fake it without touching DBOS.

**Child reach is belt-and-braces.** `cancelChildren: true` walks the engine's own `parent_workflow_id` ledger, which has a row the moment a child starts — that alone covers the child whose `mark-running` step has not yet committed to `cortex_step_executions`. The canceler additionally cancels the persisted incomplete `child_workflow_id`s and re-queries once after the parent cancel to sweep late-committing ids, so neither ledger's lag orphans a child.

**Conditional terminal write, not `updateRunStatus`.** A plain `updateRunStatus(runId, "canceled")` would clobber a concurrently-completing run's terminal status. `markRunCanceledIfActive` guards on `status IN ('running','suspended_insufficient_funds')` — the same active set `queryActiveRun` deduplicates on — and reports whether a row transitioned. No transition means the run reached its own terminal state; the canceler re-reads and reports that status as `finalStatus` instead of lying.

**Phases isolated, cancel strict.** The engine cancel itself rejects on failure — converging ledgers under a workflow that is still running would fight the body's own writes, and the host can simply retry. The four convergence phases after it are each try/logged so one failure cannot skip the rest: charge close is best-effort by design (the billing authority self-heals via its defensive open and stale reaper; a failed close loses attribution only), and mandate revoke is best-effort because an expired-mandate revoke failure must not strand the row convergence.

**Mandate revoke is a new seam method, not a reuse of `revoke`.** The terminal path's `revoke(authorization, reason)` runs under the run credential carried in workflow input. The cancel route holds no `RunAuthorization` — the mandate JWT is never persisted; only its jti is, on `cortex_runs`. `revokeByJti({ jti, auth }, reason)` covers exactly this out-of-band path. It takes the opaque `AuthContext` rather than an `orgId` string: the harness carries org identity nowhere outside `auth` (the session-model invariant), and the managed realization downcasts `auth` the same way every managed seam adapter does. Local/OSS authorizers no-op — they mint no jti. Required rather than optional so a managed embedder cannot silently ship an authorizer that strands mandates.

**No-mandate rows converge vacuously.** `converged.mandate` is `true` when the row carries no jti: there is nothing to revoke, and a vacuous `true` lets hosts alert on any `false` flag uniformly instead of special-casing OSS rows.

## Risks / Trade-offs

- [The `workflowId === runId` launch contract is assumed, not queried] → It is the invariant `execute_analysis` establishes (`runLauncher.launch(..., { workflowId: runId }, ...)`) and the result surfaces both ids so a host can cross-check.
- [A cancel between `queryRun` and the engine call can race a just-completing run] → `markRunCanceledIfActive` refuses the clobber; `sweepPendingStepExecutions` only touches still-`pending` rows, which a completed run no longer has; charge close and revoke are idempotent at their authorities.
- [`revokeByJti` is breaking for embedder authorizers] → One no-op method; the local factory already satisfies it, so only hand-built fakes and managed realizations change.

## Open Questions

None.
