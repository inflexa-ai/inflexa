## Context

`executeAnalysis` schedules steps through a pure dependency scheduler (`execute-analysis-scheduler.ts`): `scheduleReady` returns a step when every `depends_on` id is in the completed set. A failed step never enters that set, so its transitive dependents are structurally unreachable — no extra logic makes that true. On top of this sits a separate fail-fast cascade in `runSchedulerLoop` (`execute-analysis.ts`): a run-wide `failFast` flag set on the first failed/blocked/thrown child, a `cancelInFlight` sweep over every in-flight sibling, and an early-return guard at the top of `dispatchReady`.

The terminal machinery is already partial-aware: `deriveFinalStatus` lands `partial` when some steps completed and some failed, synthesis runs over whatever completed, `sweepPendingStepExecutions` flips never-started rows to `skipped`, and per-step errors persist on `cortex_step_executions.error`. Fail-fast therefore does not protect an invariant — it chooses to minimize the completed set. The plan DAG is the product's language for conditionality (a QC gate that must stop downstream work is expressed as `depends_on`), so a failure dooming steps the planner did not wire as dependents is the scheduler second-guessing the plan.

The flag currently serves three cascades. Only one is being removed:

- failure/blocker cascade (graceful `failed`/`blocked` result, or a thrown child for a non-budget cause) — **removed by this change**
- budget cascade (`budget_exceeded`, graceful or thrown; `neverFits` plan validation) — **unchanged**
- external cancel — never used the flag at all (the parent unwinds via DBOS cancellation exceptions; the `"external_cancel"` cause in `cancelInFlight`'s union has no caller)

## Goals / Non-Goals

**Goals:**

- A step failure or blocker makes only its transitive dependents unreachable; every independent ready step continues to dispatch and every in-flight sibling runs to its own conclusion.
- One uniform settlement rule: graceful `failed`, graceful `blocked`, and a thrown child (non-budget cause) all get identical treatment.
- Doomed dependents are visible in the live DAG view as `skipped` from the moment the failure settles, and land `skipped` on the ledger at run end.
- Budget-exceeded, `neverFits`, and external-cancel semantics are byte-for-byte preserved (the in-flight `resume-analysis-after-budget-pause` work depends on them).

**Non-Goals:**

- Retry/resume of a failed step or its doomed subtree.
- Any change to the budget-pause machinery or its resumability.
- Downgrading the `neverFits` halt to a per-step failure (possible follow-up, out of scope).
- CLI rendering of the `skipped` DAG tier (separate cli-subsystem change; harness publishes first).
- Any change to the pure scheduler — `scheduleReady` already expresses the desired reachability.

## Decisions

### D1: Reachability is the mechanism; no "poisoned set" is introduced

Doomed dependents are not tracked in scheduler state. `scheduleReady` already never returns a step whose dependency is unfinished, and the loop's `while (inFlight.size > 0)` terminates naturally once settled steps stop producing new ready ones. The only new computation is a UI-facing graph walk (D4). Alternative considered: an explicit skipped/poisoned set threaded through scheduling — rejected as redundant state that could drift from the reachability the completed-set already encodes.

Discovered constraint: the caller must filter settled-but-not-completed steps (failed/canceled) out of the candidate list it hands `scheduleReady`. A failed step is neither in `completed` nor in flight, so the pure scheduler would offer it again — under fail-fast that was masked (dispatch never ran after a failure); under continue-semantics it is an infinite re-dispatch loop. The filter also keeps a settled step's declared resources from weighing against the budget. The pure scheduler itself stays unchanged.

### D2: Uniform continue rule for all non-budget settlement failures

Graceful `failed`, graceful `blocked`, and a thrown child (when `isBudgetExceeded(err)` is false and the child is not in `canceledByParent`) all: add the step to `failed`, record the per-step error, mark dependents `skipped` (D4), emit the DAG snapshot, and dispatch. No sibling cancellation, no halt. Alternative considered: continue on graceful work-failures but keep the halt for thrown children (machinery failure predicts sibling failures) — rejected in favor of the simpler uniform rule; a genuinely sick backend will fail the remaining steps on their own merits, and the uniform rule keeps the settlement loop free of a second policy fork.

### D3: The halt flag survives for budget paths only

`failFast` is renamed (e.g. `halted`) and is set only by the budget cascade (`budget_exceeded` graceful/thrown, `neverFits`). The `dispatchReady` early-return guard and `cancelInFlight` remain in place for those paths. Rationale: the budget pause is acknowledged half-baked and slated for future work — this change must neither depend on nor perturb it.

### D4: Doom-marking is an eager UI walk, keyed off the failure settlement

When a non-budget failure settles, the loop walks the static plan DAG (reverse-adjacency from the failed step) and sets every transitive dependent not already terminal to `skipped` in `stepRuntime`, then emits the snapshot. The walk is over workflow-input data and checkpointed settlement state, so it replays deterministically. The `DagStepState.status` vocabulary gains `"skipped"` (contract + Zod schema in `src/contracts/`), mirroring how `"queued"` was added by resource-budgeted-scheduling. The `StepExecutionRow` DB enum is untouched — rows stay `pending` until the terminal sweep flips them to `skipped`, exactly as today. Alternatives considered: leaving doomed steps `pending` in the stream (dishonest for long runs — indistinguishable from "will still run"); reusing `"failed"` with an upstream-dependency error (stream would contradict the ledger's `skipped`).

### D5: Dispatch after every settlement

`dispatchReady()` runs after failed settlements too, not only completions. Required under budget admission: a failed step leaves the in-flight set and frees its declared capacity, which a held-for-capacity step may now claim. Without a budget the extra call is a no-op (a failure never makes a new step dependency-ready).

### D6: Run-level `failureReason` records the first failure

Settlement order is checkpointed (`DBOS.waitFirst`), so first-failure-wins is deterministic. Per-step detail already lives on `cortex_step_executions.error` and in the DAG snapshot; the run-level column is a headline, not the record. Alternative considered: an aggregate ("3 of 8 steps failed") — more honest for multi-failure runs but computable by any reader from the step ledger; not worth a bespoke format.

## Risks / Trade-offs

- [A failure that predicts sibling failures (shared dataset flaw the planner didn't encode as a dependency) burns compute discovering it N times] → The DAG is the declared truth about conditionality; planner prompts already push QC gates upstream. External cancel remains available to a user watching the run. If this bites in practice, a cheap follow-up is a failure-count circuit breaker.
- [Runs with a failure now run longer, extending the open `RunCharge` bracket] → Inherent to the feature — the extended time is spent producing artifacts the user keeps. Budget admission still bounds concurrent spend.
- [The CLI renders an unknown `skipped` status until it adopts the new tier] → Harness publishes before the CLI consumes (established two-step promotion); the CLI change is a small rendering addition. Verify the CLI's current handling of unknown statuses degrades gracefully rather than crashing before publishing.
- [A run in flight across the deploy replays its checkpointed prefix under old recorded decisions, then continues under new semantics] → Benign divergence: already-fail-fasted runs are terminal; a mid-flight run simply stops cancelling siblings from the live frontier onward. Note it in the release notes.
- [Tests that encode fail-fast flip meaning] → The budget-cascade and workflow-replay DBOS tests must pass **unchanged** — treat any needed edit there as a red flag that budget semantics drifted.

## Migration Plan

1. Land the contract addition (`skipped` in `DagStepState.status`) and the scheduler-loop change together in the harness; build `dist/`, run `bun test`.
2. Publish `@inflexa-ai/harness` (two-step promotion), then a follow-up cli-subsystem change adopts the `skipped` tier in DAG rendering.
3. Rollback is a revert of the scheduler-loop commit; the contract addition is additive and can stay.

## Open Questions

- None blocking. The `neverFits` per-step downgrade and a failure-count circuit breaker are noted as possible follow-ups, deliberately out of scope.
