# Spec Delta

## ADDED Requirements

### Requirement: search_protein reaches the conversation agent and the run synthesizer

The tool MUST be wired into the conversation agent
(`harness/src/agents/conversation-agent.ts`) and into the lookups of the run
synthesizer (`harness/src/tools/research/synthesis-lookups.ts`). The tool
describes itself, thus no prompt carries a usage note for it.

#### Scenario: Conversation agent has the tool

- **WHEN** the conversation agent is created
- **THEN** its tool array includes `searchProteinTool`

#### Scenario: The run synthesizer has the tool

- **WHEN** `createSynthesisLookupTools` builds the lookups of the synthesizer
- **THEN** the lookups include `searchProteinTool`

### Requirement: No sandbox agent holds search_protein

The tool MUST NOT be an entry in the sandbox tool registry, and
`SandboxToolName` (`harness/src/agents/sandbox/types.ts`) MUST NOT name it.
Identifier resolution answers a question of the conversation, thus no sandbox
agent reaches for one yet.

#### Scenario: No sandbox agent can declare the tool

- **WHEN** a sandbox-agent meta names the tool in `meta.tools`
- **THEN** the name is not a `SandboxToolName`, thus the typecheck rejects it

## REMOVED Requirements

### Requirement: search_protein reaches the conversation agent and the literature reviewer

**Reason**: The literature reviewer goes, and its prompt with it. A MODIFIED block cannot drop the scenario of the reviewer, thus the requirement returns under a new name.

**Migration**: Refer to "search_protein reaches the conversation agent and the run synthesizer" and "No sandbox agent holds search_protein" in this capability.
