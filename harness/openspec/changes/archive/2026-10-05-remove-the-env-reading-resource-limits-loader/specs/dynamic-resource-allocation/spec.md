## ADDED Requirements

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

## REMOVED Requirements

### Requirement: Resource ceilings loaded from the environment

**Reason**: `loadResourceLimits` had no caller in the harness, the CLI, or managed Cortex, and was absent from the package barrel. Both embedders already pass ceilings as configuration. Keeping an env-reading loader alongside that path offered a second, unvalidated source for the same three values.

**Migration**: The embedder reads its own configuration — however it chooses to name it — validates it, and passes `SandboxClientConfig.resourceLimits` / `resourcePolicy`. Cortex already does exactly this with the same `SANDBOX_MAX_*` variable names in its own schema.
