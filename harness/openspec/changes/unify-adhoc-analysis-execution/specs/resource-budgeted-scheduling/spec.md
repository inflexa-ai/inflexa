## MODIFIED Requirements

### Requirement: Resource policy shape and load-time invariants

The harness SHALL define `ResourcePolicy` in `config/resource-limits.ts`:

```typescript
interface ResourcePolicy {
  perStep: ResourceLimits;
  budget: { cpu: number; memoryGb: number };
}
```

The policy is embedder-supplied at the composition root and optional — an
embedder that supplies none gets dependency-gated fan-out plus the historical
per-step defaults. When a policy is supplied, construction SHALL reject one
where `perStep.maxCpu > budget.cpu` or
`perStep.maxMemoryGb > budget.memoryGb` (a maximum-size step must be admissible
against an empty budget). `budget.cpu` and `budget.memoryGb` MUST be positive
numbers. The policy SHALL NOT contain an execution-mode-specific resource
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

### Requirement: The machine budget is snapshotted into workflow input at launch

`execute_analysis` SHALL copy the policy's `budget` into the
`executeAnalysis` workflow input at the async edge for both plan and ad hoc
modes, before `DBOS.startWorkflow`. The workflow body SHALL read the budget only
from its input, never from live configuration, so replay after a crash
reproduces identical admission decisions.

#### Scenario: Mid-run config edit does not affect a running workflow

- **GIVEN** a run launched with `budget: { cpu: 4, memoryGb: 8 }`
- **WHEN** the embedder's configuration changes to a larger budget while the run is in flight
- **THEN** the running workflow continues admitting against `{ cpu: 4, memoryGb: 8 }`, and only a subsequently launched run sees the new value

#### Scenario: Replay uses the snapshotted budget

- **GIVEN** a workflow recovered after a host crash
- **WHEN** the scheduler loop replays
- **THEN** admission decisions derive from the budget in the workflow input and match the original execution

## REMOVED Requirements

### Requirement: Ephemeral sandbox sizing comes from the policy

**Reason**: The ephemeral sandbox and workflow are removed; ad hoc analysis is
an ordinary scheduled analysis step.

**Migration**: Remove `ResourcePolicy.ephemeral` and use the existing
`perStep` ceiling and machine `budget`. The utility router recommends the
one-step request within those bounds.
