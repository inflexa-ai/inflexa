## RENAMED Requirements

- FROM: `### Requirement: AgentMeta declares per-agent planner metadata and tool allowlist`
- TO: `### Requirement: A built-in executor declares its planner metadata and default attachments`
- FROM: `### Requirement: Planner catalog derives from the sandbox-agent meta`
- TO: `### Requirement: Planner catalog derives from the resolved catalog`

## MODIFIED Requirements

### Requirement: Code-defined sandbox agents in a directory structure

The harness MUST define each built-in sandbox agent under
`harness/src/agents/sandbox/`. The directory MUST contain these files:

- `shared.ts`: the composition root, the tool registry and `createSandboxAgent`.
- `types.ts`: the built-in definition type, the `SandboxToolName` union and `SANDBOX_AGENT_DEFAULT_MAX_ITERATIONS`.
- `index.ts`: the built-in definitions and the builder of an agent from its resolved definition.
- One file for each built-in agent.

The built-in sandbox agents MUST be the data profiler, the analyst and the drug
analyst. The set MUST NOT contain a special ephemeral executor. A custom
executor MUST be built from its resolved definition by the same composition root. Each
`AgentDefinition` MUST carry the five fields that `runLoop` reads: `id`,
`systemPrompt`, `model`, `tools`, and `maxIterations`.

#### Scenario: Catalog covers every agent

- **WHEN** each built-in sandbox agent is built from its resolved definition
- **THEN** each id resolves to an `AgentDefinition` built by `createSandboxAgent`

#### Scenario: A custom executor builds from its resolved definition

- **GIVEN** the resolved definition of a custom executor
- **WHEN** the step agent is built
- **THEN** `createSandboxAgent` builds it with its prompt and the role tools

#### Scenario: Each definition is fully populated

- **WHEN** any sandbox `AgentDefinition` is inspected
- **THEN** its `id`, `systemPrompt`, `model`, `tools`, and `maxIterations` MUST all be populated

#### Scenario: Ephemeral executor is absent

- **WHEN** the sandbox-agent source files and catalog are inspected
- **THEN** no `ephemeral-executor` definition, prompt, metadata entry, or factory entry exists

### Requirement: Composition root resolves each agent's tools from a central registry

`createSandboxAgent` MUST give each executor three tool sets: the role tools,
the tools of each connector that it attaches, and the tools of each MCP server that it attaches. The
connector tools MUST resolve against the central registry in
`resolveSandboxTools`. The role tools of an executor are these tools:

- the sandbox surface: `acquire_sandbox` and `release_sandbox`
- the mutate surface: `execute_command`, `write_file`, and `edit_file`
- the read surface: `read_file`, `list_files`, `file_stat`, `grep`, and `workspace_search` when an embedding provider is wired
- `read_tool_output` when a tool output store is supplied, after the workspace tools
- `inspect_data_profile`
- `list_available_packages` and `list_available_refs`
- the skill tools
- `report_blocker` when a blocker cell is supplied
- `submit_file_metadata` when a file-metadata cell is supplied

`inspect_data_profile` is always on, because the persisted profile is the only record of what the input dataset of the analysis is. No file on disk carries it, because the profiler deletes its scratch tree on completion. Thus an agent that cannot read the profile must derive the organism, the dimensions, and the format again from the raw bytes. Under `readOnly`, the agent MUST NOT get `write_file` and `edit_file`. It MUST keep the sandbox surface, `execute_command`, the read tools, and `inspect_data_profile`. A lease and a read of the profile are not a mutation of the analysis.

`read_tool_output` reads the kept text of a tool result that the loop cut (refer to the harness-tools capability). `SandboxAgentDeps.toolOutputStore` supplies the store, and the step body gives the same store to the loop of the agent. Under `readOnly`, the agent MUST keep `read_tool_output`, because a read of a kept text is not a mutation.

A tool with a dependency (the sandbox module, `WorkspaceFilesystem`, `ChatProvider`, `Pool`, the tool output store, the catalog credentials) MUST get it through its factory closure at the root, never through `ToolContext` or ambient state.

A sandbox agent MUST NOT get `inspect_run`. A step runs inside its own run, and `inspect_run` gives the step paths only for a finished run. The briefing names the path of each completed dependency instead.

#### Scenario: Compute-pipeline agent receives only its allowlisted tools

- **GIVEN** an executor that attaches the `pubmed` and the `geo` connectors
- **WHEN** the resolved tool list is inspected
- **THEN** it MUST contain the tools of those connectors plus the role tools
- **AND** it MUST NOT contain `chembl`, `search_faers`, or any tool of another connector

#### Scenario: No sandbox agent inspects a run

- **WHEN** the resolved tool list of any sandbox agent is inspected
- **THEN** it does not contain `inspect_run`

#### Scenario: inspect_data_profile is wired without any meta declaring it

- **GIVEN** an executor that attaches no connector
- **WHEN** its resolved tool list is inspected
- **THEN** it MUST contain `inspect_data_profile`
- **AND** it MUST still contain it when the agent is built `readOnly`

#### Scenario: The lease tools are wired without any meta declaring them

- **GIVEN** an executor that attaches no connector
- **WHEN** its resolved tool list is inspected
- **THEN** it MUST contain `acquire_sandbox` and `release_sandbox`
- **AND** it MUST still contain them when the agent is built `readOnly`

#### Scenario: Unknown tool name fails at composition time

- **GIVEN** a connector that names a `SandboxToolName` with no registry entry
- **WHEN** `createSandboxAgent` builds an agent that attaches the connector
- **THEN** it MUST throw at composition time, not at the first LLM call

#### Scenario: No SandboxClient on ToolContext

- **GIVEN** the harness `ToolContext` type
- **WHEN** the `execute` of a sandbox-agent tool is typed against it
- **THEN** the sandbox module and the `SandboxClient` MUST NOT be reachable through `ToolContext`, because the factory closure of the tool captures the module

#### Scenario: A file-metadata cell adds the output tool

- **GIVEN** a sandbox agent built with a file-metadata cell
- **WHEN** its resolved tool list is inspected
- **THEN** it contains `submit_file_metadata`
- **AND** an agent built with no cell, for example the data profiler, does not contain it

#### Scenario: A tool output store adds the read tool

- **GIVEN** a sandbox agent built with a tool output store
- **WHEN** its resolved tool list is inspected
- **THEN** it contains `read_tool_output` directly after the workspace tools, also when the agent is built `readOnly`
- **AND** the same deps with no store give the same tool list without `read_tool_output`

### Requirement: A built-in executor declares its planner metadata and default attachments

Each built-in executor MUST declare an `id`, a `name`, a `description`, its
default connectors, its default skills and an optional `defaultMaxSteps`. The
runaway cap of an executor MUST be `defaultMaxSteps ??
SANDBOX_AGENT_DEFAULT_MAX_ITERATIONS` (50). A custom executor MUST use
`SANDBOX_AGENT_DEFAULT_MAX_ITERATIONS`.

#### Scenario: Every meta has a non-empty tools field

- **WHEN** the built-in executor definitions are inspected
- **THEN** each has a non-empty list of default connectors

#### Scenario: defaultMaxSteps overrides the runaway cap

- **GIVEN** a built-in executor that sets `defaultMaxSteps: 35`
- **WHEN** its `AgentDefinition` is built
- **THEN** `maxIterations` MUST be `35`
- **AND** an agent with no `defaultMaxSteps` MUST use `SANDBOX_AGENT_DEFAULT_MAX_ITERATIONS` (50)

### Requirement: Sandbox agent system prompt is a pure function of the agent type and the kind of the step

Each sandbox `AgentDefinition.systemPrompt` MUST be assembled at construction
time by `composeSystemPrompt` (with the conversational style disabled). The
composition concatenates the prompt of the agent identity, the skill index of
its attached skills, the orient core, and `sandboxAnalysisStepStandardsPrompt`
(the last omitted under `appendAnalysisStepStandards: false`). The agent of a
template step also gets the template-step section after them. The composed
string MUST be a pure function of the agent identity, its attached skills, the
declared `toolchainSource`, and the kind of the step. From `SandboxStepCoords`,
only the presence of a step template MUST reach it: no path, no
`analysisId`/`runId`/`stepId`, no template reference, and no placeholder for
one. Two steps of one kind with one agent identity send a byte-identical prefix.

This is a **prompt-cache** invariant, not a style rule. The cache keys on an
exact prefix. A single interpolated id or path makes the system string of each
step unique. Then each step pays a full cache write and reads nothing back.
The per-step values belong in the step's seed
(`harness/src/prompts/briefing.ts`), which names the working directory, the
analysis root, the dataset, and the summary and the work directory of each
dependency. The prompt MUST be a frozen string by the time `runLoop` sees it —
there is no request-time processor pipeline.

The orient core MUST key its text on the `toolchainSource` of the sandbox
client, and on no field of the agent deps. With `"store"`, it is
`sandboxOrientCorePrompt` unchanged.

#### Scenario: System prompt is a single composed string

- **GIVEN** any sandbox `AgentDefinition`
- **WHEN** `definition.systemPrompt` is read
- **THEN** it is a `string` that holds the prompt of the identity, the orient core, and `sandboxAnalysisStepStandardsPrompt` unless the agent opts out

#### Scenario: The prompt is byte-identical across steps and leaks no per-step value

- **GIVEN** one agent identity built twice for two open steps with different `SandboxStepCoords` (different run, step, and write prefix)
- **WHEN** the two `systemPrompt` strings are compared
- **THEN** they are byte-identical
- **AND** neither contains a step path, a `runId`/`stepId`/`analysisId`, or an unsubstituted `{{…}}` placeholder

#### Scenario: A template step adds one section

- **GIVEN** the same sandbox agent built for an open step and for a template step
- **WHEN** the two `systemPrompt` strings are compared
- **THEN** the prompt of the template step holds the template-step section, and the prompt of the open step does not
- **AND** neither holds a template reference

#### Scenario: The legacy embedder keeps its prefix

- **GIVEN** a sandbox client composed with no `toolchainSource`
- **WHEN** the system prompt is composed
- **THEN** it contains `sandboxOrientCorePrompt` unchanged

### Requirement: Planner catalog derives from the resolved catalog

The planner catalog MUST derive from the resolved `AgentCatalog` when the
planner makes a plan (refer to the `agent-catalog` capability). It MUST project
`{ id, description, liveSources }` for each enabled executor. `generatePlan`
MUST read the rendered markdown of that catalog. The catalog MUST exclude the
data profiler and each agent of another role.

#### Scenario: Planner catalog excludes non-plannable agents

- **WHEN** the planner catalog is rendered
- **THEN** it MUST list each enabled executor with its `description`
- **AND** `data-profiler` MUST NOT appear
