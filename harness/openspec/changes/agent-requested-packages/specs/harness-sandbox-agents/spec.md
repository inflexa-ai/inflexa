# harness-sandbox-agents Specification

## MODIFIED Requirements

### Requirement: Composition root resolves each agent's tools from a central registry

`createSandboxAgent` MUST hand each agent exactly its `meta.tools` allowlist,
resolved against the central registry in `resolveSandboxTools`. It MUST also hand
each agent the always-on substrate, which no meta declares:

- the mutate surface: `execute_command`, `write_file`, and `edit_file`
- the read surface: `read_file`, `list_files`, `file_stat`, `grep`, and
  `workspace_search` when an embedding provider is wired
- `inspect_data_profile`
- the skill tools that `meta.skills` declares
- `report_blocker`, when a blocker cell is supplied
- the `link_packages` tool, when a farm-extension seam is supplied

The `link_packages` tool obeys the shape of `report_blocker`: an optional
dependency yields the tool, and its absence yields no tool. This is capability
degradation, and it is not a path for an older embedder. An embedder that binds
no seam holds no such capability, and no code branches on which realization is
bound.

`inspect_data_profile` is always-on for one reason. The persisted profile is the
only record of what the input dataset of the analysis IS. No file on disk carries
it, because the scratch tree of the profiler is deleted on completion. Thus an
agent that cannot pull it has no fallback but to derive the organism, the
dimensions, and the format from the raw bytes again. Under `readOnly` the
`write_file`/`edit_file` pair MUST be omitted. `execute_command`, the read tools,
and `inspect_data_profile` MUST stay, because a read of the profile is not a
mutation.

An unknown `SandboxToolName` MUST throw at composition time, and not at the first
LLM call. A tool that needs dependencies (`SandboxClient`, `WorkspaceFilesystem`,
`ChatProvider`, `Pool`) MUST receive them through its factory closure at the
root, and never through `ToolContext` or ambient state. `BASE_SANDBOX_TOOLS`
(`listAvailablePackages`, `listAvailableRefs`, `resolveLibraryId`, `queryDocs`,
`inspectRun`) MUST be spread into the `meta.tools` of each agent, thus the
planner metadata and the resolved tool record stay in agreement.

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

#### Scenario: The `link_packages` tool follows its seam

- **GIVEN** two composition roots, one that binds a farm-extension seam and one that binds none
- **WHEN** an agent is composed under each
- **THEN** only the agent under the bound seam holds the `link_packages` tool
- **AND** no `meta.tools` declares it, exactly as none declares `report_blocker`

#### Scenario: Unknown tool name fails at composition time

- **GIVEN** an `AgentMeta` whose `tools` names a `SandboxToolName` with no registry entry
- **WHEN** `createSandboxAgent` builds the agent
- **THEN** it MUST throw at composition time rather than at the first LLM call

#### Scenario: No SandboxClient on ToolContext

- **GIVEN** the harness `ToolContext` type
- **WHEN** the `execute` of a sandbox-agent tool is typed against it
- **THEN** the `SandboxClient` MUST NOT be reachable through `ToolContext` — the factory closure of the tool captures it
