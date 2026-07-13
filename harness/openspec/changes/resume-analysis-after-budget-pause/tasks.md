# Tasks — resume an analysis after a 402 budget pause

> Not started. Placeholder for the deferred enhancement. Requires a product
> decision before implementation.

## 1. Resume entry point

- [ ] Add a resume helper: given a paused `run_id`, guard that the run is
  `suspended_insufficient_funds` (else no-op/404), bump the reintroduced attempt
  counter, and return the parent `workflowId` + new attempt
- [ ] Call `DBOS.resumeWorkflow(parentWorkflowId)` and explicitly
  `DBOS.resumeWorkflow(childWorkflowId)` for each still-`CANCELLED` child
- [ ] Expose it as an operator CLI hook (`inflexa run --resume <id>`) / host route

## 2. Cache-busting on replay

- [ ] Reintroduce a per-run attempt counter (column + `bumpRunAttemptCount`, or
  an equivalent naming scheme) — this time with a real caller
- [ ] Thread it into `open-running-charge:${n}` / `close-running-charge:${n}` /
  `revoke-run-auth:${n}` and the child LLM/tool step names so the resumed body
  misses the cached `budget_exceeded` steps

## 3. Fresh charge + un-suspend

- [ ] Open a fresh managed-root running charge on resume (replacing the one closed
  with `budget_exceeded`)
- [ ] Transition the analysis row out of `suspended_insufficient_funds` back to
  `running` on a successful resume

## 4. Surface + specs

- [ ] Update the CLI paused-run message to promise resume once wired
- [ ] Spec deltas: `workflow-failure-lifecycle` (resume half), `run-state-persistence`
  (reintroduced counter), `cortex-state-layer` (un-suspend), CLI `analysis-run-launch`
