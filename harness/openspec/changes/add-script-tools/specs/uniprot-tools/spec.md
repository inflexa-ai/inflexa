# Spec Delta

## MODIFIED Requirements

### Requirement: search_protein reaches the conversation agent and the run synthesizer

The tool MUST be a script tool of the conversation agent
(`harness/src/agents/conversation-agent.ts`), which calls it from `run_script`
(refer to the script-tools capability). It MUST also be a lookup of the run
synthesizer (`harness/src/tools/research/synthesis-lookups.ts`). The tool
describes itself, thus no prompt carries a usage note for it.

#### Scenario: Conversation agent has the tool

- **WHEN** the conversation agent is created
- **THEN** its script tools include `searchProteinTool`, and its tools do not

#### Scenario: The run synthesizer has the tool

- **WHEN** `createSynthesisLookupTools` builds the lookups of the synthesizer
- **THEN** the lookups include `searchProteinTool`
