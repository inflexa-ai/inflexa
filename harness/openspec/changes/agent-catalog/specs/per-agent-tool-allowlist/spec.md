## RENAMED Requirements

- FROM: `### Requirement: AgentMeta.tools is a required SandboxToolName array`
- TO: `### Requirement: A built-in executor declares its default connectors`
- FROM: `### Requirement: createSandboxAgent wires the allowlist plus the always-on substrate`
- TO: `### Requirement: createSandboxAgent wires the connector tools plus the role tools`

## MODIFIED Requirements

### Requirement: Unknown tool names fail at composition time

`createSandboxAgent` MUST throw at composition time when a connector of the
registry names a `SandboxToolName` that the tool registry does not realize. One
member is the exception: `knowledgeTemplate` MUST resolve to nothing when the
embedder binds no knowledge client or the agent holds no mutator. The absence
of the knowledge plane is the default state of the open-source host, and never
a wiring fault.

An unknown connector id in a catalog entry is a gap, not a throw (refer to the
`agent-catalog` capability).

#### Scenario: Unknown tool name throws during agent construction

- **GIVEN** a connector that names a tool with no realization
- **WHEN** an agent that attaches the connector is built
- **THEN** construction throws and names the tool
- **AND** no agent definition is produced

#### Scenario: The template tool is absent without a client

- **GIVEN** an executor that attaches the `knowledge` connector and deps without a knowledge client
- **WHEN** the agent is built
- **THEN** construction succeeds and the tool list holds no `knowledge_template`

#### Scenario: Each agent lists the template tool

- **WHEN** the default connectors of each built-in executor are read
- **THEN** each holds the `knowledge` connector

### Requirement: A built-in executor declares its default connectors

Each built-in executor MUST declare its default connectors as connector ids of
the registry. A CI test MUST make sure that each default connector exists. The
`SandboxToolName` union MUST stay the closed set of the tools that the
connectors and the role tools name.

#### Scenario: AgentMeta type requires tools

- **WHEN** the type of a built-in executor definition is inspected
- **THEN** its list of default connectors is present and non-optional

#### Scenario: Every agent meta declares tools

- **WHEN** the built-in executor definitions are inspected
- **THEN** each declares a non-empty list of default connectors

#### Scenario: A typo in a default connector fails CI

- **GIVEN** a built-in executor whose default connectors name `pubmd`
- **WHEN** the CI test runs
- **THEN** the test fails and names the executor and `pubmd`

### Requirement: createSandboxAgent wires the connector tools plus the role tools

`createSandboxAgent(deps, agent, opts?)` MUST resolve the tools of each
connector of the resolved agent through `resolveSandboxTools`. It MUST add them to the
tools of the agent, beside the role tools. The role tools of an executor are
these tools:

- the workspace read tools
- the workspace mutate tools, omitted in read-only mode
- `read_tool_output` when a tool output store is supplied, directly after the workspace tools
- `list_available_packages` and `list_available_refs`
- the skill tools of the agent
- `report_blocker` when the deps set `reportsBlocker`
- `submit_file_metadata` when a file-metadata cell is supplied, as the last tool of the agent

No connector names a role tool.

#### Scenario: Agent with only the base set receives base plus substrate

- **GIVEN** a resolved agent that attaches no connector and no MCP server
- **WHEN** `createSandboxAgent(deps, agent)` is invoked
- **THEN** the tool array of the agent contains only the role tools
- **AND** no research or bio-lookup tool is present

#### Scenario: Agent with extra declared tools receives them all

- **GIVEN** a resolved agent that attaches the `chembl` connector
- **WHEN** `createSandboxAgent(deps, agent)` is invoked
- **THEN** the tool array of the agent contains the tools of `chembl` plus the role tools

#### Scenario: A file-metadata cell adds submit_file_metadata as the last tool

- **GIVEN** deps that carry a file-metadata cell
- **WHEN** `createSandboxAgent(deps, agent)` is invoked
- **THEN** the last tool of the agent is `submit_file_metadata`
- **AND** the same deps with no cell give the same tool array without `submit_file_metadata`

#### Scenario: A tool output store adds read_tool_output after the workspace tools

- **GIVEN** deps that carry a tool output store
- **WHEN** `createSandboxAgent(deps, agent)` is invoked
- **THEN** `read_tool_output` directly follows the last workspace tool
- **AND** the same deps with no store give the same tool array without `read_tool_output`
