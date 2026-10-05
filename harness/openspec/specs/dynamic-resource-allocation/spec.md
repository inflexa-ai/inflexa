# dynamic-resource-allocation Specification

## Purpose

Governs how a sandbox step's CPU/memory/GPU request and execution timeout are
bounded before a sandbox machine is created. The embedder supplies the cluster
ceilings as configuration (`SandboxClientConfig.resourceLimits`, or a
`resourcePolicy` that `parseResourcePolicy` validates); the harness reads no
environment variable for them. Each step's planner-estimated request is then
**clamped** to those ceilings rather than rejected.

Clamp-don't-throw is deliberate: a planner over-estimate is not an error that
should fail a step — capping the request keeps the pod quota-admissible while
still running the work. So `clampResources` returns a capped spec and never
throws; there is no `validateResources` gate and no `ResourceLimitExceededError`.
The only hard failure is misconfiguration: `parseResourcePolicy` throws
`ResourceLimitsConfigError` when an embedder policy is invalid or when a
per-step ceiling exceeds the machine budget. Step timeout is taken from the plan's `step.timeout` when set, otherwise
the constant `DEFAULT_STEP_TIMEOUT_SECONDS` (3600). Image selection is not part
of this capability — the image comes from configuration, not from agent metadata.

## Requirements

### Requirement: Resource requests are clamped, never rejected

Before creating a sandbox machine, `createSandboxClient.createSandbox` SHALL clamp
the step's `ResourceSpec` to the configured `ResourceLimits` via `clampResources`,
capping `cpu` to `maxCpu`, `memoryGb` to `maxMemoryGb`, and (when present)
`gpu.count` to `maxGpuCount`. Clamping SHALL NOT throw on an over-limit request
and SHALL NOT aggregate or report violations. A request with no `resources` at all
is a caller error and SHALL throw — clamping covers over-estimates, not omission.

#### Scenario: Request within limits is unchanged

- **GIVEN** limits `{ maxCpu: 16, maxMemoryGb: 64, maxGpuCount: 2 }` and request `{ cpu: 8, memoryGb: 32 }`
- **WHEN** `clampResources` runs
- **THEN** it returns `{ cpu: 8, memoryGb: 32 }` and the sandbox is created with those values

#### Scenario: Over-limit CPU and memory are capped

- **GIVEN** limits `{ maxCpu: 16, maxMemoryGb: 64, maxGpuCount: 2 }` and request `{ cpu: 32, memoryGb: 128 }`
- **WHEN** `clampResources` runs
- **THEN** it returns `{ cpu: 16, memoryGb: 64 }` without throwing

#### Scenario: Over-limit GPU count is capped

- **GIVEN** limits with `maxGpuCount: 1` and request `{ cpu: 8, memoryGb: 32, gpu: { count: 2 } }`
- **WHEN** `clampResources` runs
- **THEN** the returned spec has `gpu.count: 1`

### Requirement: Step timeout from the plan with a constant fallback

The workflow SHALL use the step's `timeout` field (seconds) when the plan
provides one, and otherwise fall back to the constant
`DEFAULT_STEP_TIMEOUT_SECONDS` (3600). `AnalysisStepSchema` SHALL carry an
optional `timeout` field (number, seconds).

#### Scenario: Step specifies a timeout

- **GIVEN** a plan step with `timeout: 7200`
- **WHEN** the workflow runs the step
- **THEN** the step's execution deadline uses 7200 seconds

#### Scenario: Step omits a timeout

- **GIVEN** a plan step with no `timeout` field
- **WHEN** the workflow runs the step
- **THEN** the step's execution deadline uses `DEFAULT_STEP_TIMEOUT_SECONDS` (3600 seconds)

### Requirement: Resource type definitions

The system SHALL define the resource types as Zod schemas:

```typescript
interface ResourceLimits {
  maxCpu: number;       // positive
  maxMemoryGb: number;  // positive; camelCase "Gb"
  maxGpuCount: number;  // non-negative integer
}

interface ResourceSpec {
  cpu: number;          // positive
  memoryGb: number;     // positive
  gpu?: GpuSpec;
}

interface GpuSpec {
  count: number;        // positive integer; no "type" field
}
```

There is no `allowedGpuTypes` field on `ResourceLimits` and no `type` field on
`GpuSpec`.

#### Scenario: ResourceLimits validates

- **GIVEN** the `ResourceLimitsSchema`
- **WHEN** validating `{ maxCpu: 16, maxMemoryGb: 64, maxGpuCount: 1 }`
- **THEN** validation passes

### Requirement: Resource ceilings are supplied by the embedder

The harness SHALL receive cluster ceilings as configuration and SHALL NOT read them from the environment. `SandboxClientConfig.resourceLimits` carries `ResourceLimits { maxCpu, maxMemoryGb, maxGpuCount }`, and `parseResourcePolicy` validates an embedder-supplied `ResourcePolicy` against `ResourcePolicySchema`, throwing `ResourceLimitsConfigError` when the shape is invalid or when a per-step ceiling exceeds the machine budget. `maxCpu` and `maxMemoryGb` MUST be positive numbers; `maxGpuCount` MUST be a non-negative integer. GPU is bounded by count only, never by type.

Where those values come from is the host's business — an environment variable, a file, a control plane. Reading them is the host's, done once against the host's own validated configuration, so the harness and its embedder cannot hold two views of one ceiling.

#### Scenario: Valid ceilings are accepted as configuration

- **GIVEN** an embedder supplying `{ maxCpu: 16, maxMemoryGb: 64, maxGpuCount: 2 }`
- **WHEN** the sandbox client is constructed
- **THEN** those ceilings are the ones `clampResources` caps each step's request against

#### Scenario: A malformed ceiling is rejected

- **GIVEN** an embedder supplying a resource policy whose `maxGpuCount` is `1.5`
- **WHEN** `parseResourcePolicy` runs
- **THEN** it throws `ResourceLimitsConfigError` identifying the value must be a non-negative integer

#### Scenario: The harness reads no ceiling from the environment

- **GIVEN** `SANDBOX_MAX_CPU`, `SANDBOX_MAX_MEMORY_GB`, and `SANDBOX_MAX_GPU_COUNT` set in the process environment
- **WHEN** the harness bounds a step's resources
- **THEN** it uses only the embedder-supplied ceilings, and no harness code path consults those variables
