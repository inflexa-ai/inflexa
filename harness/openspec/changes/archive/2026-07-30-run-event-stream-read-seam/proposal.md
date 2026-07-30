## Why

Every workflow in an analysis run already writes a rich, typed event stream — `data-dag-state` on each scheduling transition, and `data-step-activity` on **every sandbox-agent tool call**, carrying a human phrase like `Running script deseq2.R`. That stream is durable and complete, and it is **write-only**: the harness ships no way to read it back, so no embedder can show a user what a run is actually doing.

Without a read side, embedders are pushed into reconstructing progress from whatever else is legible, which today means reading DBOS's own internal step-cache tables. That is both a layering violation and structurally unable to answer the question: those tables record a step only when it *completes*, so during the long operations that matter they describe the thing that just finished, never the thing in flight. Shipping the read side is what makes the durable stream usable for its purpose.

## What Changes

- **New**: a host-agnostic run-event subscription seam. Given a run id, it delivers that run's typed event parts to a caller-supplied handler until the run is terminal, then completes.
- The seam **fans in** the run's parent workflow stream and every child sandbox-step stream. Child streams are discovered from `cortex_step_executions.child_workflow_id`, which the workflow bodies already persist, and children joining mid-run are picked up as they appear.
- The seam **folds reconciling parts latest-wins by part id**, so a subscriber attaching mid-run converges on current state rather than replaying stale intermediates.
- The seam **quarantines DBOS**: the delivered parts are the existing `contracts/` types, and no durability-engine type appears in its signature — the same boundary `RunLauncher` draws for starting workflows.
- The application `pg.Pool` **bounds connection acquisition**, so a caller waiting on a saturated pool fails in bounded time instead of waiting forever. This is defensive hardening of a driver default, not a fix for a diagnosed incident: pool exhaustion was raised as one candidate explanation for an embedder's stalled view and was never confirmed. It is included here because this change adds long-lived readers to a process that already holds the pool, which is what makes an unbounded wait worth closing now.
- **Not in scope**: sandbox command *output*. The sandbox server emits only file-tree events today (`images/sandbox-base/server/executor.go`), so no read side can surface stdout/stderr live. Recorded as a follow-up rather than implied.

## Capabilities

### New Capabilities
- `run-event-stream`: the read side of the durable per-run event stream — subscription lifecycle, parent/child fan-in, reconciling-part folding, ordering and termination guarantees, and failure isolation.

### Modified Capabilities
- `run-observation-seam`: its scope-limiting requirement already defers sub-step detail to "the workflow's durable event stream" without naming anything readable. That deferral now names `run-event-stream` as the capability that carries it, so the two seams read as a deliberate pair rather than a gap.
- `postgres-storage-backend`: the app pool gains a bounded connection-acquisition timeout, so pool exhaustion surfaces as an error rather than an unbounded wait.

## Impact

- **New**: a run-event stream reader module under `harness/src/`, exported from `harness/src/index.ts`.
- **Modified**: `harness/src/lib/storage.ts` (pool options); `harness/src/index.ts` (exports).
- **Read, not modified**: `harness/src/contracts/` part types and `PART_REGISTRY` (the `reconciling` flag is the fold key); `cortex_step_executions` (child workflow ids).
- **Downstream**: unblocks the CLI's run panel, which today reads `dbos.operation_outputs`. That rewiring is a separate CLI change.
- **No breaking changes**: purely additive to the public surface; `observeRun` and every existing seam are untouched.
