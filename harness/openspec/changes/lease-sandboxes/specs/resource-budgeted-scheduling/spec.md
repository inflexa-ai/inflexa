## REMOVED Requirements

### Requirement: Resource policy shape and load-time invariants

**Reason**: The scheduler admits no step against a budget, thus this capability holds nothing more. The policy shape moves to the sandbox-leases capability.

**Migration**: Refer to "The resource policy gives the per-step ceiling and the lease budget" in sandbox-leases.

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
