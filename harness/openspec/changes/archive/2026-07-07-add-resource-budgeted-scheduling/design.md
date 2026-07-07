# Design — resource-budgeted scheduling

## Context

Today the pieces around the gap already exist:

- Every plan step **must** declare `resources: { cpu, memoryGb, gpu? }` (`schemas/plan-schemas.ts`), and the planner prompt has a "Resource Estimation" section (defaults 4 CPU / 8 GB).
- Per-step ceilings (`ResourceLimits { maxCpu, maxMemoryGb, maxGpuCount }`) are enforced by `clampResources` at sandbox creation (`sandbox/create-sandbox.ts`), and the Docker/K8s backends translate the clamped spec into hard container limits (`NanoCpus`/`Memory`; K8s resource requests).
- The CLI already owns a `harness.resourceLimits` config key and passes it to `createSandboxClient` at its composition root.
- The planner already has terminal `report_blocker` / `request_clarification` tools and a non-terminal `validate_plan` dry-run.

What is missing: any cap on **how many steps run concurrently** (`dispatchReady` fans out every ready step), any statement of the limits **to the planner**, any **plan-time validation** against the ceilings (the clamp is silent), and any way for the machine's **total** capacity — as opposed to a single step's — to be expressed.

Constraint: the scheduler loop is a DBOS workflow body kept replay-stable by design — `scheduleReady` is a pure function and completion order is checkpointed via `DBOS.waitFirst`. Any admission logic must preserve that.

## Goals / Non-Goals

**Goals:**

- A single embedder-supplied resource policy: per-step ceilings (existing `ResourceLimits`) + a machine budget `{ cpu, memoryGb }` for concurrent-step admission.
- Scheduler throttles step parallelism against the budget, weighted by each step's declared `resources`.
- Planner knows the limits, shapes plans to fit, and can honestly refuse via `report_blocker`; `validate_plan` enforces the per-step ceiling deterministically.
- OOM kills are distinguishable from generic sandbox death in the failure reason.
- Ephemeral runs size their sandbox from the policy instead of a hardcoded const.

**Non-Goals:**

- Cross-run / cross-workflow global admission. The local CLI is single-user; a run + a data-profile (or two runs) may jointly exceed the budget. Deliberately accepted; a DBOS queue with global concurrency is the known escalation path if this ever matters.
- GPU budgeting. Per-step GPU-count clamping is unchanged; the budget covers CPU + memory only.
- Changing clamp-don't-throw at sandbox creation (`dynamic-resource-allocation` spec). The clamp stays exactly as specified — it just becomes a backstop that plan-time validation should render should-never-fire.
- Cgroup knobs beyond the existing CPU/memory container limits (pids, blkio, swap).

## Decisions

### D1: Weighted admission, not a count cap

Admit a ready step iff `sum(inFlight.cpu) + step.cpu <= budget.cpu` **and** `sum(inFlight.memoryGb) + step.memoryGb <= budget.memoryGb`. Rationale: the weights already exist (plan schema requires per-step `resources`), and a count can't distinguish six 1-CPU steps from two 8-CPU steps — the actual starvation scenario. A count cap is the degenerate case (uniform weights), so nothing is lost. Alternative considered: DBOS queues with a concurrency limit — durable and global for free, but count-only and it bypasses the scheduler's existing dispatch/cancel bookkeeping; rejected for the primary mechanism.

### D2: Admission lives in `scheduleReady`; determinism preserved

`scheduleReady` stays a pure function, extended from `(plan, completed, inFlight)` to also take the budget and the in-flight steps' resource sum. Each scheduling round iterates ready steps in stable plan order, greedily admitting what fits (skip-over allowed: a small step may pass a blocked large one — among-ready order carries no semantic meaning in a dependency-gated DAG). All inputs derive from checkpointed state (`DBOS.waitFirst` sequence + workflow input), so replay reproduces identical admission decisions.

### D3: Budget snapshotted into workflow input at launch

`executePlan` copies the policy's budget into the `executeAnalysis` workflow input at the async edge. Rationale: reading live config from the workflow body would make replay diverge if the user edits config mid-run. Same pattern as `RunSession` riding in workflow input. Consequence: a config change applies to the *next* run, never a running one — acceptable and easy to explain.

### D4: Plan-time rejection in `validate_plan`; clamp demoted to backstop

`validate_plan` (and `submit_plan`'s re-validation) rejects any step whose declared `resources` exceed the per-step ceiling, returning actionable feedback ("step X requests 16 GB; host allows 8") so the planner resizes, restructures, or calls `report_blocker`. Rationale: the LLM must not be the only line of defense, and today's silent clamp produces the worst failure mode — a plan that looks fine and dies hours later. The sandbox-creation clamp is intentionally untouched (see Non-Goals): stored plans from before this change, or embedders without the policy, still get the old behavior.

Additional invariants enforced at policy load: `perStep.maxCpu <= budget.cpu` and `perStep.maxMemoryGb <= budget.memoryGb` (a single max-size step must be admissible against an empty budget). Defensive executor guard: a step that can never fit an empty budget fails immediately with a clear reason instead of waiting forever.

### D5: Planner is told the limits; `report_blocker` is the infeasibility exit

The planner prompt's Resource Estimation section gains the concrete ceilings (injected like `{{AGENT_CATALOG}}`), plus guidance: steps must fit the per-step ceiling; total concurrency is budget-limited so prefer fewer/serial heavy steps; if the analysis genuinely cannot be done within these limits, call `report_blocker` with the resource shortfall as the reason. No new planner tool — the existing terminal outcome (`error`) already models this, and the conversation agent already relays it.

### D6: OOM surfaces as a death cause, not a new status

`isAlive` widens from `boolean` to carry a cause (Docker: `State.OOMKilled` from the same inspect call already made; K8s: container status `OOMKilled` reason). The watchdog stamps `sandbox-oom-killed` instead of `sandbox-dead` in the synthetic failure reason, which already flows to the step failure surface. The step's terminal status stays `failed` — `blocked` remains reserved for agent-declared blockers (structural honesty), and no stream/DB schema changes are needed.

### D7: Policy shape and plumbing

```ts
interface ResourcePolicy {
  perStep: ResourceLimits;          // existing shape, existing clamp
  budget: { cpu: number; memoryGb: number };
  ephemeral?: ResourceSpec;         // default sandbox size for run_ephemeral
}
```

Lives beside `ResourceLimits` in `config/resource-limits.ts`. Supplied by the embedder at the composition root (`assembleCoreRuntime`), flowing to: sandbox client (per-step clamp, unchanged), `executePlan` (budget snapshot), `generate_plan` deps (prompt injection + validation ceiling), and `EphemeralDeps` (sizing). The CLI extends its existing `harness.resourceLimits` key to this shape and prompts during `inflexa setup`, suggesting defaults from detected host resources (e.g. half of `os.cpus()` / `os.totalmem()`).

### D8: Budget-held steps are visibly `"queued"` in the dag-state part

`DagStepState.status` (the `data-dag-state` typed part) gains one enum value, `"queued"`: dependency-satisfied but held for budget capacity. Dependency-held steps stay `"pending"`. Rationale: without it, a throttled run looks stalled — the user sees satisfied dependencies and no progress. The part is already reconciling (latest-wins by stable id), so the scheduler just re-emits dag-state when a step enters/leaves the queued state; replay stability holds because the emit derives from the same checkpointed admission decision. The `StepExecutionRow.status` DB enum is deliberately untouched — a queued step has no row-visible lifecycle change, and adding a DB status would ripple into `deriveFinalStatus` for zero read-side value.

## Risks / Trade-offs

- [Large ready steps can be starved by a stream of small ones under greedy skip-over admission] → Accepted for v1: plans are finite and small (typically < 15 steps), capacity frees as steps complete, and fail-fast bounds runaway plans. Revisit with an aging rule only if observed.
- [Steps that under-declare resources still blow past the budget in aggregate] → Per-container hard limits (existing clamp + container caps) bound each step; the budget bounds the *declared* sum. Honest declarations are incentivized by plan-time validation feedback; OOM surfacing (D6) makes under-declaration visible instead of mysterious.
- [Concurrent workflows (run + data-profile + ephemeral) jointly exceed the budget] → Explicitly out of scope (single-user local CLI). Documented; DBOS-queue global cap is the known escalation.
- [Budget snapshot means a mid-run config change has no effect on that run] → Intended (replay stability). Surfaced in CLI docs.
- [Old stored plans with over-ceiling steps] → Unchanged behavior: run-time clamp still applies; only *new* plan generation gets the stricter gate.

## Open Questions

- Should the scheduler emit a visible "queued: waiting for capacity" step activity so the UI can distinguish budget-waiting from dependency-waiting? (Small, but touches the typed part vocabulary — decide at spec-delta time.)
- Exact `inflexa setup` UX for suggesting defaults (fractions vs absolute values) — CLI-side decision, does not block harness spec deltas.
