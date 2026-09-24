## MODIFIED Requirements

### Requirement: createSandboxAgent wires the allowlist plus the always-on substrate

`createSandboxAgent(deps, meta, body, opts?)` MUST resolve `meta.tools` through `resolveSandboxTools` and add the result to the tools of the agent, beside the always-on substrate. The substrate is these tools:

- the workspace read tools
- the workspace mutate tools, omitted in read-only mode
- `read_tool_output` when a tool output store is supplied, directly after the workspace tools
- the skill tools of the agent
- `report_blocker` when a blocker cell is supplied
- `submit_file_metadata` when a file-metadata cell is supplied, as the last tool of the agent

`BASE_SANDBOX_TOOLS` is part of the allowlist that each meta spreads into its own `tools`, not an extra tool that the root adds. `read_tool_output` is part of the substrate, thus no meta declares it.

#### Scenario: Agent with only the base set receives base plus substrate

- **GIVEN** a meta whose `tools` is exactly `BASE_SANDBOX_TOOLS`
- **WHEN** `createSandboxAgent(deps, meta, body)` is invoked
- **THEN** the tool array of the agent contains the five base tools plus the always-on workspace substrate
- **AND** no other research or bio-lookup tool is present

#### Scenario: Agent with extra declared tools receives them all

- **GIVEN** a meta whose `tools` declares the ChEMBL family beside the base set
- **WHEN** `createSandboxAgent(deps, meta, body)` is invoked
- **THEN** the tool array of the agent contains each declared tool plus the workspace substrate

#### Scenario: A file-metadata cell adds submit_file_metadata as the last tool

- **GIVEN** deps that carry a file-metadata cell
- **WHEN** `createSandboxAgent(deps, meta, body)` is invoked
- **THEN** the last tool of the agent is `submit_file_metadata`
- **AND** the same deps with no cell give the same tool array without `submit_file_metadata`

#### Scenario: A tool output store adds read_tool_output after the workspace tools

- **GIVEN** deps that carry a tool output store
- **WHEN** `createSandboxAgent(deps, meta, body)` is invoked
- **THEN** `read_tool_output` directly follows the last workspace tool
- **AND** the same deps with no store give the same tool array without `read_tool_output`
