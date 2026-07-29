## MODIFIED Requirements

### Requirement: Code-defined sandbox agents in a directory structure

The harness SHALL define every sandbox agent under `harness/src/agents/sandbox/`.
The directory SHALL contain `shared.ts` (the composition root: tool registry,
`BASE_SANDBOX_TOOLS`, `createSandboxAgent`, `resolveSandboxTools`), `types.ts`
(the `AgentMeta` interface, the `SandboxToolName` union, and
`SANDBOX_AGENT_DEFAULT_MAX_ITERATIONS`), `index.ts` (the `SANDBOX_AGENT_META`
record and the `createSandboxAgents(deps)` builder), and one file per agent. The
agent set SHALL cover the data-profiler, the omics specialists,
scientific-executor, cheminformatics, translational-safety,
pkpd-clinical-response, immune-profiling, and drug-repurposing. It SHALL NOT
contain a special ephemeral executor. Each `AgentDefinition` SHALL carry the
five fields `runAgent` consumes: `id`, `systemPrompt`, `model`, `tools`, and
`maxIterations`.

#### Scenario: Catalog covers every agent

- **WHEN** the keys of `SANDBOX_AGENT_META` are compared to `createSandboxAgents(deps)`
- **THEN** every agent id SHALL map to an `AgentMeta` entry
- **AND** every id SHALL resolve to an `AgentDefinition` built by `createSandboxAgent(deps, meta, body)`

#### Scenario: Each definition is fully populated

- **WHEN** any sandbox `AgentDefinition` is inspected
- **THEN** its `id`, `systemPrompt`, `model`, `tools`, and `maxIterations` SHALL all be populated

#### Scenario: Ephemeral executor is absent

- **WHEN** the sandbox-agent source files and catalog are inspected
- **THEN** no `ephemeral-executor` definition, prompt, metadata entry, or factory entry exists
