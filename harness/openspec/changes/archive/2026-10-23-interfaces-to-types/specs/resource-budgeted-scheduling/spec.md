## MODIFIED Requirements

### Requirement: Resource policy shape and load-time invariants

The harness SHALL define `ResourcePolicy` in `config/resource-limits.ts`:

```typescript
type ResourcePolicy = {
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
