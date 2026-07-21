## Why

`executeAnalysis` fail-fasts on the first step failure: it cancels every in-flight sibling and stops scheduling, even for steps on completely independent DAG branches. The dependency tree is already the plan's language for "this work is conditional on that work" (a QC gate that should stop downstream work is expressed as `depends_on`), and the run machinery already treats partial outcomes as first-class (`partial` terminal status, synthesis over completed steps, pending→`skipped` sweep). Fail-fast therefore protects no invariant — it just minimizes the completed set, discarding independent work the user paid sandbox and LLM cost to start and must re-buy in a full new run.

## What Changes

- **Continue on step failure.** When a child settles as `failed`, `blocked`, or by throwing (for any non-budget cause), the parent no longer cancels in-flight siblings or halts scheduling. Only the failed step's transitive dependents become unreachable — they are never dispatched (a failed step never enters the completed set, so `scheduleReady` never returns them) and are swept to `skipped` at run end. One uniform rule for all three settlement shapes.
- **Budget semantics untouched.** The `budget_exceeded` cascade (graceful or thrown), the `neverFits` plan-validation halt, and external cancel keep today's stop-everything behavior. The run-halt flag survives for those paths only.
- **Dispatch after every settlement.** Failed settlements now also trigger a dispatch round — under budget admission, a failure frees declared capacity that a held-for-capacity step may claim.
- **`skipped` tier in the DAG stream part.** `data-dag-state` gains a `skipped` step status; the moment a failure settles, the failed step's transitive dependents are marked `skipped` in the snapshot instead of sitting `pending` for the rest of the run. (CLI rendering of the new tier is a follow-up in the cli subsystem; harness publishes first.)
- **Run-level `failureReason` becomes a summary.** Per-step errors already live on `cortex_step_executions.error` and the DAG snapshot; the single run-level column records the first failure (deterministic settlement order).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `harness-durable-runtime`: the core scheduling requirement changes from "first step failure or declared blocker cancels in-flight siblings and stops scheduling" to "a step failure or blocker makes only its transitive dependents unreachable; independent ready steps continue to dispatch; budget-exceeded and external cancel retain the halt cascade".
- `harness-sandbox-agents`: the blocker scenario no longer mandates cancelling in-flight siblings — a blocker dooms its dependents exactly like a failure.
- `workflow-failure-lifecycle`: the finalisation hook's path enumeration loses its fail-fast path (runs with step failures drain the loop and finalise, typically `partial`); the pending→`skipped` sweep now covers dependents that were unreachable because an upstream step failed.
- `resource-budgeted-scheduling`: capacity-freeing broadens — a held-for-capacity step is admitted when an in-flight sibling settles (completes **or fails**), not only when it completes; the `neverFits` guard states its halt semantics explicitly instead of referencing the removed "standard fail-fast".

The `data-dag-state` `skipped` status lands as an ADDED requirement in `harness-durable-runtime` (mirroring how `"queued"` was added by resource-budgeted-scheduling). `step-execution-tracking` needs no delta: the ledger's enum, sweep helper, and row behavior are unchanged — only purpose-prose framing of when `skipped` arises shifts, which archiving the durable-runtime delta captures.

## Impact

- **Code**: `src/workflows/execute-analysis.ts` (`runSchedulerLoop` settlement branches, doom-marking walk, `dispatchReady` call sites, halt-flag rename to reflect budget-only purpose); `src/contracts/chat-parts.ts` + `src/contracts/schemas/` (dag-state `skipped` status). The pure scheduler (`execute-analysis-scheduler.ts`) is unchanged — dependency gating already produces the desired reachability.
- **Tests**: `execute-analysis.test.ts` fail-fast/blocked/provenance tests flip to continue-semantics; new tests for independent-branch-continues, dependent-never-dispatched-and-skipped, multi-failure `partial`, capacity-freed-by-failure. `__tests__/dbos/budget-cascade.test.ts` and `workflow-replay.test.ts` must stay green unchanged (budget semantics are frozen).
- **Consumers**: the CLI's DAG rendering should learn the `skipped` tier (separate cli-subsystem change; harness must publish before the CLI consumes — two-step promotion).
- **Upgrade edge**: a run in flight across the deploy replays its checkpointed prefix under recorded decisions and continues under the new semantics from the live frontier — benign; fail-fasted runs are already terminal.
- **Out of scope**: budget-pause resume work (`resume-analysis-after-budget-pause`), retry-from-failed-step, `neverFits` per-step downgrade, CLI rendering.
