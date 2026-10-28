## RENAMED Requirements

- FROM: `### Requirement: Step timeout from the plan with a constant fallback`
- TO: `### Requirement: Each command has a timeout, and a step has none`

## MODIFIED Requirements

### Requirement: Resource requests are clamped, never rejected

Before the admission of a lease, the sandbox module MUST clamp the requested
`ResourceSpec` to the configured `ResourceLimits` with `clampResources`. The clamp
caps `cpu` to `maxCpu`, `memoryGb` to `maxMemoryGb`, and (when present)
`gpu.count` to `maxGpuCount`. `acquire` MUST give the clamped size, thus the
agent learns the size that it holds. Clamping MUST NOT throw on an over-limit request,
and it MUST NOT aggregate or report violations. A request with no size at all
is a caller error and MUST throw — clamping covers over-estimates, not omission.

#### Scenario: Request within limits is unchanged

- **GIVEN** limits `{ maxCpu: 16, maxMemoryGb: 64, maxGpuCount: 2 }` and request `{ cpu: 8, memoryGb: 32 }`
- **WHEN** `clampResources` runs
- **THEN** it returns `{ cpu: 8, memoryGb: 32 }` and the lease is admitted with those values

#### Scenario: Over-limit CPU and memory are capped

- **GIVEN** limits `{ maxCpu: 16, maxMemoryGb: 64, maxGpuCount: 2 }` and request `{ cpu: 32, memoryGb: 128 }`
- **WHEN** `clampResources` runs
- **THEN** it returns `{ cpu: 16, memoryGb: 64 }` without throwing

#### Scenario: Over-limit GPU count is capped

- **GIVEN** limits with `maxGpuCount: 1` and request `{ cpu: 8, memoryGb: 32, gpu: { count: 2 } }`
- **WHEN** `clampResources` runs
- **THEN** the returned spec has `gpu.count: 1`

#### Scenario: Acquire gives the clamped size

- **GIVEN** limits `{ maxCpu: 4, maxMemoryGb: 16, maxGpuCount: 0 }`
- **WHEN** a consumer acquires `{ cpu: 8, memoryGb: 64 }`
- **THEN** `acquire` gives `{ cpu: 4, memoryGb: 16 }`, and the budget admits that size

### Requirement: Each command has a timeout, and a step has none

A plan step MUST carry no `timeout` field, and `DEFAULT_STEP_TIMEOUT_SECONDS` MUST NOT exist. A step has no deadline of its own. Each exec MUST have a command timeout: the `timeoutSeconds` of the request, else `DEFAULT_COMMAND_TIMEOUT_SECONDS` (3600). The deadline of the poll loop of the exec MUST be the command timeout plus a poll grace.

#### Scenario: A command with no timeout gets the default

- **GIVEN** an `execute_command` call with no `timeoutSeconds`
- **WHEN** the exec submits the command
- **THEN** the submit carries `timeoutSeconds: 3600`, and the poll deadline is 3600 seconds plus the grace

#### Scenario: A command timeout above the default

- **GIVEN** an `execute_command` call with `timeoutSeconds: 7200`
- **WHEN** the exec submits the command
- **THEN** sandbox-server stops the command after 7200 seconds, and the exec gives the result with `timedOut: true`

#### Scenario: A wait for a grant uses no time of the step

- **GIVEN** a step whose `acquire_sandbox` call waited 2 hours in the queue
- **WHEN** the agent runs its first command
- **THEN** the command gets its full timeout

#### Scenario: Step specifies a timeout

- **GIVEN** a stored plan whose step carries `timeout: 7200`
- **WHEN** the harness parses the plan
- **THEN** the parsed step holds no `timeout`, and the parse does not fail

#### Scenario: Step omits a timeout

- **GIVEN** a plan step with no `timeout` field
- **WHEN** the workflow runs the step
- **THEN** the step has no deadline, and each command of the step gets its own command timeout

### Requirement: Resource ceilings are supplied by the embedder

The harness MUST receive cluster ceilings as configuration, and it MUST NOT read them from the environment. `SandboxClientConfig.resourceLimits` carries `ResourceLimits { maxCpu, maxMemoryGb, maxGpuCount }`. `parseResourcePolicy` validates an embedder-supplied `ResourcePolicy` against `ResourcePolicySchema`. It throws `ResourceLimitsConfigError` when the shape is invalid, or when a per-step ceiling exceeds the machine budget. `maxCpu` and `maxMemoryGb` MUST be positive numbers, and `maxGpuCount` MUST be a non-negative integer. The count bounds a GPU, and the type never does.

Where those values come from is the host's business — an environment variable, a file, a control plane. The host reads them one time, against its own validated configuration. Thus the harness and its embedder cannot hold two views of one ceiling.

#### Scenario: Valid ceilings are accepted as configuration

- **GIVEN** an embedder supplying `{ maxCpu: 16, maxMemoryGb: 64, maxGpuCount: 2 }`
- **WHEN** the sandbox module is constructed
- **THEN** those ceilings are the ones `clampResources` caps each lease request against

#### Scenario: A malformed ceiling is rejected

- **GIVEN** an embedder supplying a resource policy whose `maxGpuCount` is `1.5`
- **WHEN** `parseResourcePolicy` runs
- **THEN** it throws `ResourceLimitsConfigError` identifying the value must be a non-negative integer

#### Scenario: The harness reads no ceiling from the environment

- **GIVEN** `SANDBOX_MAX_CPU`, `SANDBOX_MAX_MEMORY_GB`, and `SANDBOX_MAX_GPU_COUNT` set in the process environment
- **WHEN** the harness bounds the size of a lease
- **THEN** it uses only the embedder-supplied ceilings, and no harness code path consults those variables
