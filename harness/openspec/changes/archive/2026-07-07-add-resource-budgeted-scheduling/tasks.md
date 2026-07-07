# Tasks — add-resource-budgeted-scheduling

## 1. Resource policy foundation

- [x] 1.1 Define `ResourcePolicy` (+ Zod schema) in `src/config/resource-limits.ts` with load-time invariants (`perStep` ceilings ≤ `budget`, positive budget values); unit tests for accept/reject cases
- [x] 1.2 Thread the optional policy through `assembleCoreRuntime` (`src/runtime/assemble.ts`) to the consumers wired below; absent policy preserves current behavior everywhere

## 2. Scheduler admission

- [x] 2.1 Add the budget to the `executeAnalysis` workflow input type and snapshot it in `executePlan` at the async edge (before `DBOS.startWorkflow`)
- [x] 2.2 Extend `scheduleReady` (`src/workflows/execute-analysis-scheduler.ts`) with weighted admission: budget + in-flight resource sum params, stable plan-order greedy skip-over, no-budget = legacy fan-out; keep it a pure function with unit tests (fits/waits, skip-over, legacy, replay-identical decisions)
- [x] 2.3 Wire admission into `runSchedulerLoop`/`dispatchReady` (`src/workflows/execute-analysis.ts`): track in-flight declared resources, re-run admission when `DBOS.waitFirst` reports a completion, never-fits guard fails the step with a shortfall-naming error (standard fail-fast follows)
- [x] 2.4 Add `"queued"` to `StepStatus` in `src/contracts/chat-parts.ts` and emit dag-state transitions (pending → queued → running) from the scheduler; assert replay-stable emit ordering in the existing scheduler workflow tests

## 3. Planner awareness

- [x] 3.1 Inject per-step ceilings + machine budget into the planner prompt's Resource Estimation section (`src/prompts/planner.ts`), including the report_blocker-on-infeasibility instruction; default guidance unchanged when no policy
- [x] 3.2 Add the deterministic over-ceiling check to `validate_plan` / `submit_plan` re-validation (`src/schemas/validate-plan.ts`) with step-naming actionable issues; unit tests for over/at/under ceiling
- [x] 3.3 Plumb the policy into `generate_plan` deps (`src/tools/research/generate-plan.ts`)

## 4. OOM surfacing

- [x] 4.1 Widen `isAlive` to report a death cause: Docker `State.OOMKilled` (`src/sandbox/docker-client.ts`), K8s container terminated reason `OOMKilled` (`src/sandbox/k8s-client.ts`)
- [x] 4.2 Stamp `sandbox-oom-killed` vs `sandbox-dead` in the watchdog's synthetic failure (`src/sandbox/watchdog.ts`) and in the recovery liveness re-check path; unit test the reason selection

## 5. Ephemeral sizing

- [x] 5.1 Replace the `EPHEMERAL_SANDBOX_RESOURCES` const with a policy-overridable construction-time dep on `EphemeralDeps` (`src/execution/ephemeral-runner.ts`), falling back to `{ cpu: 4, memoryGb: 8 }`

## 6. Docs and verification

- [x] 6.1 Update `CONTEXT.md` (Step glossary entry, scheduler wording) and `CLAUDE.md` (design principle 9) to say dependency-gated AND budget-admitted
- [x] 6.2 Run `tsc -p tsconfig.json` and `bun test`; fix fallout

## 7. CLI embedder wiring (cli/ subsystem — coordinate, spec deltas live in cli/openspec)

- [x] 7.1 Extend the `harness` config key (`cli/src/modules/harness/config.ts`) to the `ResourcePolicy` shape with backward-compatible defaults for existing configs
- [x] 7.2 Add a resource step to `inflexa setup` (`cli/src/modules/infra/setup.ts`) suggesting defaults from detected host resources (`os.cpus()`, `os.totalmem()`)
- [x] 7.3 Pass the policy at the composition root (`cli/src/modules/harness/runtime.ts`)
