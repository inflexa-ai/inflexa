## MODIFIED Requirements

### Requirement: Composition root resolves each agent's tools from a central registry

`createSandboxAgent` MUST give each agent exactly its `meta.tools` allowlist, resolved against the central registry in `resolveSandboxTools`, plus the always-on substrate. No meta declares the substrate. The substrate is these tools:

- the sandbox surface: `acquire_sandbox` and `release_sandbox`
- the mutate surface: `execute_command`, `write_file`, and `edit_file`
- the read surface: `read_file`, `list_files`, `file_stat`, `grep`, and `workspace_search` when an embedding provider is wired
- `read_tool_output` when a tool output store is supplied, after the workspace tools
- `inspect_data_profile`
- the skill tools that `meta.skills` declares
- `report_blocker` when a blocker cell is supplied
- `submit_file_metadata` when a file-metadata cell is supplied

`inspect_data_profile` is always on, because the persisted profile is the only record of what the input dataset of the analysis is. No file on disk carries it, because the profiler deletes its scratch tree on completion. Thus an agent that cannot read the profile must derive the organism, the dimensions, and the format again from the raw bytes. Under `readOnly`, the agent MUST NOT get `write_file` and `edit_file`. It MUST keep the sandbox surface, `execute_command`, the read tools, and `inspect_data_profile`. A lease and a read of the profile are not a mutation of the analysis.

`read_tool_output` reads the kept text of a tool result that the loop cut (refer to the harness-tools capability). `SandboxAgentDeps.toolOutputStore` supplies the store, and the step body gives the same store to the loop of the agent. Under `readOnly`, the agent MUST keep `read_tool_output`, because a read of a kept text is not a mutation.

An unknown `SandboxToolName` MUST throw at composition time, not at the first LLM call. A tool with a dependency (the sandbox module, `WorkspaceFilesystem`, `ChatProvider`, `Pool`, the tool output store) MUST get it through its factory closure at the root, never through `ToolContext` or ambient state. Each agent MUST spread `BASE_SANDBOX_TOOLS` (`listAvailablePackages`, `listAvailableRefs`, `resolveLibraryId`, `queryDocs`, `inspectRun`) into its `meta.tools`. Thus the planner metadata and the resolved tool record stay in sync.

#### Scenario: Compute-pipeline agent receives only its allowlisted tools

- **GIVEN** an agent whose meta declares `tools: [...BASE_SANDBOX_TOOLS, "searchPubMed", "getArticleDetails", "searchGeoDatasets"]`
- **WHEN** the resolved tool list is inspected
- **THEN** it MUST contain exactly those tools plus the always-on substrate
- **AND** it MUST NOT contain `searchCompounds`, `searchFaers`, `searchToxcast`, or any tool outside the allowlist

#### Scenario: inspect_data_profile is wired without any meta declaring it

- **GIVEN** a sandbox agent whose `meta.tools` never names a data-profile tool
- **WHEN** its resolved tool list is inspected
- **THEN** it MUST contain `inspect_data_profile`
- **AND** it MUST still contain it when the agent is built `readOnly`

#### Scenario: The lease tools are wired without any meta declaring them

- **GIVEN** a sandbox agent whose `meta.tools` names no lease tool
- **WHEN** its resolved tool list is inspected
- **THEN** it MUST contain `acquire_sandbox` and `release_sandbox`
- **AND** it MUST still contain them when the agent is built `readOnly`

#### Scenario: Unknown tool name fails at composition time

- **GIVEN** an `AgentMeta` whose `tools` names a `SandboxToolName` with no registry entry
- **WHEN** `createSandboxAgent` builds the agent
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
