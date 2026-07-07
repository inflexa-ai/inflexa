# resource-budgeted-scheduling Specification

## Purpose

Keep concurrent analysis steps from starving the host: an embedder-supplied
`ResourcePolicy` declares per-step ceilings and a machine-wide budget, the
`executeAnalysis` scheduler admits dependency-satisfied steps only as their
declared resources fit the budget (snapshotted into the workflow input so
replay admits identically), and the ephemeral runner's sandbox size becomes
policy-overridable. Without a policy, scheduling behaves as pure dependency-
gated fan-out. Planner awareness of the same limits lives in the
planning-enhancements capability; OOM-kill surfacing lives in
harness-sandbox-exec.

## Requirements

### Requirement: Resource policy shape and load-time invariants

The harness SHALL define `ResourcePolicy` in `config/resource-limits.ts`:

```typescript
interface ResourcePolicy {
  perStep: ResourceLimits;                    // existing shape; existing clamp semantics
  budget: { cpu: number; memoryGb: number };  // total across concurrently running steps
  ephemeral?: ResourceSpec;                   // default sandbox size for runEphemeral
}
```

The policy is embedder-supplied at the composition root and optional — an embedder that supplies none gets today's behavior everywhere. When a policy is supplied, construction SHALL reject one where `perStep.maxCpu > budget.cpu` or `perStep.maxMemoryGb > budget.memoryGb` (a maximum-size step must be admissible against an empty budget). `budget.cpu` and `budget.memoryGb` MUST be positive numbers.

#### Scenario: Valid policy accepted

- **WHEN** a policy with `perStep: { maxCpu: 4, maxMemoryGb: 8, maxGpuCount: 0 }` and `budget: { cpu: 8, memoryGb: 16 }` is constructed
- **THEN** construction succeeds

#### Scenario: Per-step ceiling exceeding the budget is rejected

- **WHEN** a policy with `perStep.maxMemoryGb: 32` and `budget.memoryGb: 16` is constructed
- **THEN** construction throws a configuration error naming the violated invariant

### Requirement: The machine budget is snapshotted into workflow input at launch

`executePlan` SHALL copy the policy's `budget` into the `executeAnalysis` workflow input at the async edge, before `DBOS.startWorkflow`. The workflow body SHALL read the budget only from its input, never from live configuration, so replay after a crash reproduces identical admission decisions.

#### Scenario: Mid-run config edit does not affect a running workflow

- **GIVEN** a run launched with `budget: { cpu: 4, memoryGb: 8 }`
- **WHEN** the embedder's configuration changes to a larger budget while the run is in flight
- **THEN** the running workflow continues admitting against `{ cpu: 4, memoryGb: 8 }`, and only a subsequently launched run sees the new value

#### Scenario: Replay uses the snapshotted budget

- **GIVEN** a workflow recovered after a host crash
- **WHEN** the scheduler loop replays
- **THEN** admission decisions derive from the budget in the workflow input and match the original execution

### Requirement: Ready steps are admitted against the budget by declared weight

`scheduleReady` SHALL remain a pure function, extended to take the budget and the in-flight steps' declared resources. A dependency-satisfied step SHALL be admitted only when `sum(inFlight.cpu) + step.cpu <= budget.cpu` AND `sum(inFlight.memoryGb) + step.memoryGb <= budget.memoryGb`, using each step's plan-declared `resources`. Each scheduling round SHALL consider candidates in stable plan order, greedily admitting every candidate that fits; a candidate that does not fit SHALL NOT block a later, smaller candidate (skip-over). When the workflow input carries no budget, every dependency-satisfied step SHALL be admitted (legacy fan-out).

#### Scenario: A ready step waits for capacity

- **GIVEN** a budget of `{ cpu: 4, memoryGb: 8 }` and two in-flight steps declaring `{ cpu: 2, memoryGb: 4 }` each
- **WHEN** a third step declaring `{ cpu: 2, memoryGb: 4 }` becomes dependency-satisfied
- **THEN** it is not started until an in-flight step completes and frees capacity

#### Scenario: A smaller later candidate skips over a blocked larger one

- **GIVEN** remaining capacity `{ cpu: 2, memoryGb: 4 }` and ready candidates in plan order: `stepA { cpu: 4, memoryGb: 8 }`, `stepB { cpu: 1, memoryGb: 2 }`
- **WHEN** the scheduler runs an admission round
- **THEN** `stepB` starts and `stepA` remains held

#### Scenario: No budget in workflow input preserves legacy behavior

- **GIVEN** a workflow input without a budget
- **WHEN** three independent steps become dependency-satisfied
- **THEN** all three child workflows start immediately

### Requirement: A step that can never fit the budget fails immediately

If a dependency-satisfied step's declared resources exceed the budget outright (it could not be admitted even against an empty budget), the scheduler SHALL mark it `failed` with an error naming the resource shortfall rather than holding it indefinitely. Plan-time validation makes this unreachable for newly generated plans; the guard covers stored plans and defensive depth. Standard fail-fast semantics apply.

#### Scenario: An over-budget step fails with a clear reason

- **GIVEN** a budget of `{ cpu: 4, memoryGb: 8 }` and a stored plan step declaring `{ cpu: 8, memoryGb: 16 }`
- **WHEN** the step becomes dependency-satisfied
- **THEN** the step is marked `failed` with an error naming the declared resources and the budget, and fail-fast proceeds as for any step failure

### Requirement: Budget-held steps are visibly distinguishable from dependency-held steps

The `DagStepState.status` vocabulary in the `data-dag-state` part SHALL gain a `"queued"` value: dependency-satisfied but held for budget capacity. Dependency-held steps SHALL remain `"pending"`. The scheduler SHALL emit the updated dag-state when a step enters or leaves the queued state. The `StepExecutionRow.status` database enum SHALL NOT change — queued visibility is a stream concern only.

#### Scenario: A budget-held step shows as queued

- **GIVEN** a dependency-satisfied step held for capacity
- **WHEN** the scheduler emits `data-dag-state`
- **THEN** that step's status is `"queued"` while a dependency-held sibling remains `"pending"`

#### Scenario: An admitted step transitions queued to running

- **GIVEN** a step previously emitted as `"queued"`
- **WHEN** capacity frees and its child workflow starts
- **THEN** the next `data-dag-state` emit shows the step as `"running"`

### Requirement: Ephemeral sandbox sizing comes from the policy

`runEphemeral` SHALL size its sandbox from `policy.ephemeral` when the embedder supplies one, falling back to the built-in default `{ cpu: 4, memoryGb: 8 }`. The value remains subject to the existing per-step clamp at sandbox creation.

#### Scenario: Policy overrides the ephemeral default

- **GIVEN** a policy with `ephemeral: { cpu: 2, memoryGb: 4 }`
- **WHEN** a `run_ephemeral` sandbox is created
- **THEN** the sandbox is requested with `{ cpu: 2, memoryGb: 4 }`

#### Scenario: Absent policy falls back to the default

- **GIVEN** no resource policy supplied at the composition root
- **WHEN** a `run_ephemeral` sandbox is created
- **THEN** the sandbox is requested with `{ cpu: 4, memoryGb: 8 }`
