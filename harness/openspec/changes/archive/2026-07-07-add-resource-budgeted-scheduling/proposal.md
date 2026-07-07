# Add resource-budgeted scheduling

## Why

The `executeAnalysis` scheduler is deliberately maximally parallel: `dispatchReady` starts a child workflow for **every** dependency-satisfied step the moment its `depends_on` set completes, with no concurrency cap. On the local CLI each step is its own Docker container running compute-heavy R/Python work, so a plan with N independent steps launches N concurrent sandboxes and can starve the user's machine (the harness's only per-step defense is a *silent* clamp to `ResourceLimits` at sandbox creation — a step planned at 16 GB on an 8 GB-max host is quietly shrunk and then OOMs or thrashes mid-run). The planner is never told the host's limits, so it cannot shape steps to fit or honestly refuse an analysis that cannot fit.

## What Changes

- **New machine resource budget** (`{ cpu, memoryGb }`): an embedder-supplied policy value describing how much of the host the harness may use *in total across concurrently running steps*. Supplied at the composition root and **snapshotted into the `executeAnalysis` workflow input** at launch so replay is stable under config edits.
- **Resource-weighted scheduler admission**: `scheduleReady` gates ready steps on remaining budget capacity, not just dependency satisfaction — a ready step starts only when the sum of in-flight steps' declared `resources` plus its own fits the budget. Dependency gating is unchanged; a count cap is the degenerate case (all steps weigh 1). **BREAKING** for the documented "maximum natural parallelism, no wave batching" scheduler contract — dispatch becomes dependency-gated *and* budget-admitted.
- **Planner limit awareness + infeasibility flagging**: the planner prompt receives the per-step ceilings (and machine budget) as context; `validate_plan` deterministically **rejects** steps whose declared `resources` exceed the per-step ceiling (feedback, not terminal), so the planner resizes or — if the analysis genuinely cannot fit — exits via the existing `report_blocker` terminal tool. The run-time clamp at sandbox creation is unchanged and demoted to a should-never-fire backstop.
- **OOM-kill surfacing**: the sandbox liveness check reports a death cause; a container the backend killed for exceeding its memory limit surfaces as a synthetic failure with reason `sandbox-oom-killed` instead of the generic `sandbox-dead`. No new terminal step status — the step remains `failed`; `blocked` stays reserved for agent-declared blockers.
- **Ephemeral runner sizing from policy**: the hardcoded `EPHEMERAL_SANDBOX_RESOURCES = { cpu: 4, memoryGb: 8 }` becomes a policy-overridable construction-time dep.

Explicitly out of scope: cross-run/global admission (single-user local CLI assumption — two concurrent runs may jointly exceed the budget), GPU budgeting (per-step GPU count clamping is unchanged), and any change to the clamp-don't-throw semantics at sandbox creation.

## Capabilities

### New Capabilities

- `resource-budgeted-scheduling`: the machine resource budget — its shape, how the embedder supplies it, its snapshot into workflow input, the weighted admission rule in the scheduler (deterministic, replay-stable, starvation/never-fits guards), and policy-driven ephemeral sandbox sizing.

### Modified Capabilities

- `planning-enhancements`: planner context gains the host's resource ceilings; `validate_plan` gains a deterministic over-ceiling rejection; `report_blocker` is the documented exit when an analysis cannot be planned within the limits.
- `harness-durable-runtime`: the scheduler contract changes from "start every ready step immediately" to "start ready steps as budget capacity admits" (dependency gating, fail-fast, and `DBOS.waitFirst` selection unchanged).
- `harness-sandbox-exec`: `isAlive` widens to carry a death cause; the watchdog's synthetic failure distinguishes `sandbox-oom-killed` from `sandbox-dead`.

## Impact

- **Harness**: `workflows/execute-analysis.ts` + `execute-analysis-scheduler.ts` (admission), `workflows/execute-analysis` input type + `executePlan` launch edge (budget snapshot), `config/resource-limits.ts` (policy type), `prompts/planner.ts` + `schemas/validate-plan.ts` (planner awareness/validation), `sandbox/docker-client.ts` / `k8s-client.ts` / `sandbox/watchdog.ts` (death cause), `execution/ephemeral-runner.ts` (sizing dep), `runtime/assemble.ts` (policy plumbing).
- **CLI (embedder, own subsystem/spec tree)**: extend the existing `harness.resourceLimits` config key into the fuller policy (per-step ceilings + machine budget), prompt for it in `inflexa setup` with defaults suggested from detected host resources, and pass it at the composition root (`cli/src/modules/harness/runtime.ts`). Tracked here for coordination; spec deltas for the CLI live in `cli/openspec`.
- **Docs**: `CONTEXT.md` scheduler wording ("maximum natural parallelism") and `CLAUDE.md` architecture notes need updating alongside the spec deltas.
