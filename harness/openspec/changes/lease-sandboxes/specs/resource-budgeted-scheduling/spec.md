## MODIFIED Requirements

### Requirement: Resource policy shape and load-time invariants

The harness MUST define `ResourcePolicy` in `config/resource-limits.ts`:

```typescript
type ResourcePolicy = {
  perStep: ResourceLimits;
  budget: { cpu: number; memoryGb: number };
}
```

The policy is embedder-supplied at the composition root and optional. The `budget` is the budget of the lease grant, and it covers each lease of each consumer (see the sandbox-leases capability). An embedder that supplies no policy gets a grant at once for each lease, plus the historical per-step defaults.

When a policy is supplied, construction MUST reject one
where `perStep.maxCpu > budget.cpu` or
`perStep.maxMemoryGb > budget.memoryGb`. The module clamps each lease request to `perStep`, thus a clamped request always fits an empty budget. `budget.cpu` and `budget.memoryGb` MUST be positive
numbers. The policy MUST NOT contain an execution-mode-specific resource
field.

#### Scenario: Valid policy accepted

- **WHEN** a policy with `perStep: { maxCpu: 4, maxMemoryGb: 8, maxGpuCount: 0 }` and `budget: { cpu: 8, memoryGb: 16 }` is constructed
- **THEN** construction succeeds

#### Scenario: Per-step ceiling exceeding the budget is rejected

- **WHEN** a policy with `perStep.maxMemoryGb: 32` and `budget.memoryGb: 16` is constructed
- **THEN** construction throws a configuration error naming the violated invariant

#### Scenario: Resource policy has no ephemeral value

- **WHEN** configuration includes an `ephemeral` resource value
- **THEN** the resolved `ResourcePolicy` contains no `ephemeral` field and no special execution budget is supplied

#### Scenario: No policy grants each lease at once

- **GIVEN** an embedder that supplies no `ResourcePolicy`
- **WHEN** some consumers acquire a lease at the same time
- **THEN** each lease gets its grant with no wait for capacity

## REMOVED Requirements

### Requirement: The machine budget is snapshotted into workflow input at launch

**Reason**: The admission moves to the lease grant. The grant reads the budget from the configuration at each grant, and a step of the lease workflow checkpoints the decision. Thus a replay reads the recorded grant, and the run input needs no copy of the budget.

**Migration**: The `executeAnalysis` workflow input holds no budget. A host removes the budget from the deps of the run trigger.

### Requirement: Ready steps are admitted against the budget by declared weight

**Reason**: The scheduler starts each step when its dependencies are complete. A plan step declares no resources, and the step agent selects the size of its sandbox. The sandbox-leases capability admits each lease against the budget.

**Migration**: None for a host. The wait of a step for capacity is the wait of its `acquire_sandbox` call.

### Requirement: A step that can never fit the budget fails immediately

**Reason**: A plan step declares no resources. The module clamps each lease request to `perStep`, and `perStep` is never above the budget. Thus no request can exceed an empty budget.

**Migration**: None.

### Requirement: Budget-held steps are visibly distinguishable from dependency-held steps

**Reason**: The scheduler holds no step for capacity, thus the DAG status `queued` has no meaning. The wait for a grant shows as the activity of the `acquire_sandbox` call of the step.

**Migration**: A host removes the render of the DAG status `queued`. `DagStepState.status` no longer holds that value.
