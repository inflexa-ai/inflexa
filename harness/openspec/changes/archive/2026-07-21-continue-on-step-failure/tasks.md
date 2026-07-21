## 1. Contract: `skipped` DAG tier

- [x] 1.1 Add `"skipped"` to the `DagStepState.status` vocabulary in `src/contracts/chat-parts.ts` and its Zod wire schema in `src/contracts/schemas/chat-parts.ts`
- [x] 1.2 Extend the dag-state conformance test so a snapshot carrying a `skipped` step validates against the wire schema

## 2. Scheduler loop: failure isolation

- [x] 2.1 Rename `failFast` to `halted` in `runSchedulerLoop` and confine it to the budget paths: `neverFits` guard, graceful `budget_exceeded` cancel, and thrown `budget_exceeded` — verify no failure/blocked branch sets it afterward
- [x] 2.2 In the graceful `failed`/`blocked` settlement branch: stop setting the halt flag and stop calling `cancelInFlight`; record the step failed with its per-step error as today
- [x] 2.3 In the thrown-child settlement branch (non-budget cause, not `canceledByParent`): same treatment — record failed, no sibling cancellation, no halt
- [x] 2.4 Keep `failureReason` first-failure-wins across both branches (checkpointed settlement order makes it deterministic)
- [x] 2.5 Add a doom-marking walk: on each non-budget failure/blocker settlement, walk the plan DAG's reverse adjacency from the failed step and set every non-terminal transitive dependent to `skipped` in `stepRuntime`, then emit the DAG snapshot
- [x] 2.6 Call `dispatchReady()` after failed/blocked/thrown settlements as well as completions, so freed budget capacity admits held steps
- [x] 2.7 Confirm `deriveFinalStatus`, the terminal sweep, synthesis-over-completed, and `collectAndComplete` need no changes (they are already partial-aware) — adjust only if a test proves otherwise

## 3. Tests

- [x] 3.1 Flip `execute-analysis.test.ts` "10.7 fail-fast: B errors → A and C cancelled" to continue-semantics: B errors → A and C run to completion, run finalises `partial`, B's error on the ledger
- [x] 3.2 Flip "blocked fail-fast: B blocked → A and C cancelled" the same way: siblings complete, only B's dependents are never dispatched
- [x] 3.3 Add a diamond-DAG test (`A → B → D`, `A → C → E`): B fails while C runs → C and E complete, D never dispatched and swept to `skipped`, status `partial`
- [x] 3.4 Add a stream-vs-ledger test: after B fails, the emitted `data-dag-state` shows D `skipped` while D's `cortex_step_executions` row still reads `pending` until the terminal sweep
- [x] 3.5 Add a budget test: a held-for-capacity step is admitted after an in-flight sibling fails and frees capacity
- [x] 3.6 Add a multi-failure test: two independent steps fail → run finalises `partial` (some completed) with `failureReason` = first failure in settlement order, both per-step errors on the ledger
- [x] 3.7 Update the failed-path provenance test: `step_completed(failed)` for the failed step, `step_completed(completed)` for surviving siblings, never-dispatched dependents emit nothing
- [x] 3.8 Rename/reframe the sweep test ("fail-fast sweeps still-pending rows to skipped") to unreachable-dependent sweeping; keep the 402-pause-preserves-pending test unchanged
- [x] 3.9 Verify `__tests__/dbos/budget-cascade.test.ts` and `workflow-replay.test.ts` pass **unchanged** — any needed edit there is a red flag that budget semantics drifted

## 4. Verify and close out

- [x] 4.1 Run `tsc -p tsconfig.json` and `bun test`; run `bun run format:file` on every touched `src/` file
- [x] 4.2 Run the harness:verify skill flow (build dist, link into a scratch consumer) since the CLI does not yet consume the new contract value
- [x] 4.3 Confirm the CLI's current DAG rendering degrades gracefully on an unknown `skipped` status (read-only check in `cli/`; the rendering follow-up is a separate cli-subsystem change)
- [x] 4.4 `openspec validate continue-on-step-failure --strict` passes; note the deploy edge (mid-flight runs adopt continue-semantics at the live frontier) in the PR description
