# Spec Delta

## MODIFIED Requirements

### Requirement: alphafold_prediction is available to the conversation agent only

The tool MUST be a script tool of the conversation agent
(`harness/src/agents/conversation-agent.ts`), thus the agent calls it from
`run_script` (refer to the script-tools capability). It MUST NOT be an entry in
the sandbox tool registry, and `SandboxToolName`
(`harness/src/agents/sandbox/types.ts`) MUST NOT name it. A structural lookup
answers a question of the conversation, thus no sandbox agent reaches for one
yet.

#### Scenario: Conversation agent has the tool

- **WHEN** the conversation agent is created
- **THEN** its script tools include `alphafoldPredictionTool`, and its tools do not

#### Scenario: No sandbox agent can declare the tool

- **WHEN** a sandbox-agent meta names the tool in `meta.tools`
- **THEN** the name is not a `SandboxToolName`, thus the typecheck rejects it
