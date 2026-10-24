## MODIFIED Requirements

### Requirement: AgentMeta.tools is a required SandboxToolName array

`AgentMeta` (`src/agents/sandbox/types.ts`) SHALL include a required
`tools: readonly SandboxToolName[]` field, and every sandbox-agent meta SHALL
declare a non-empty `tools` array.

#### Scenario: AgentMeta type requires tools

- **WHEN** the `AgentMeta` type is inspected
- **THEN** `tools: readonly SandboxToolName[]` is present and non-optional

#### Scenario: Every agent meta declares tools

- **WHEN** the entries of `SANDBOX_AGENT_META` are inspected
- **THEN** every entry has a non-empty `tools` array
