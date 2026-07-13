# Resume an analysis after a 402 budget pause

> Status: **captured, not scheduled.** This is a deferred-enhancement placeholder
> (the repo's "issue") — a design gate, not an in-flight change. It was carved out
> when the incomplete resume scaffolding was retired (see the archived
> `resolve-harness-wiring-gaps`, Decision 4). Do not start it without a product
> decision.

## Why

`executeAnalysis` already **pauses** on insufficient budget: a child self-cancels
with `budget_exceeded`, the run reaches `canceled`, the analysis flips to
`suspended_insufficient_funds`, the running charge closes with `budget_exceeded`,
and the parent self-cancels to `CANCELLED` (not `ERROR`) so it stays
DBOS-resumable. What is missing is the other half — **resuming** that paused run
after the user tops up. Today a paused run is a dead end: the CLI reports
"suspended for insufficient funds" and tells the user to resume "once run resume
lands." That entry point was scaffolded but never built (the phantom "change 9"),
and its incomplete pieces were removed to stop advertising a capability that did
not exist.

## What Changes

Build the resume path end to end:

- A **resume entry point** (an operator CLI hook / host route) that, given a
  paused `run_id`, verifies the run is `suspended_insufficient_funds`, then calls
  `DBOS.resumeWorkflow(parentWorkflowId)` and re-drives the `CANCELLED` children.
- A **step-name cache-busting mechanism** so the resumed parent body does not
  replay the cached `budget_exceeded` steps. The retired design used a
  `cortex_runs.attempt_count` counter threaded into `open-running-charge:${n}` /
  `close-running-charge:${n}` / `revoke-run-auth:${n}` and the child LLM step
  names; the rebuild re-introduces an equivalent (a counter, or another
  never-before-seen naming scheme) — this time with a real caller.
- A **fresh managed-root charge** opened on resume to replace the one that closed
  with `budget_exceeded` on the pause.
- CLI messaging updated to promise resume once it is actually wired.

## Impact

- Specs: `workflow-failure-lifecycle` (resume half), `run-state-persistence` (the
  reintroduced counter/column), `cortex-state-layer` (un-suspend transition), and
  the CLI's `analysis-run-launch` (the resume command).
- Code: `workflows/execute-analysis.ts`, `workflows/sandbox-step.ts`, a new
  resume helper + entry point, `state/runs.ts`, and the CLI `run` surface.
- No migration risk to the pause path — it stays as-is; this is purely additive.
