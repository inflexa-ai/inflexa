# Spec Delta

## MODIFIED Requirements

### Requirement: PubChem tools are available via the per-agent allowlist and the conversation agent

The PubChem tool `pubchem` MUST be an entry in the central sandbox tool
registry that `resolveSandboxTools` (`harness/src/agents/sandbox/shared.ts`)
resolves. It reaches a sandbox agent only when the `meta.tools` allowlist of
that agent names it. It MUST also be a script tool of the conversation agent
(`harness/src/agents/conversation-agent.ts`), which calls it from `run_script`
(refer to the script-tools capability).

#### Scenario: Sandbox agent resolves PubChem tools from its allowlist

- **WHEN** a sandbox-agent meta lists `pubchem` in `meta.tools`
- **THEN** `createSandboxAgent` resolves it through `resolveSandboxTools` and adds it to the tool array of that agent

#### Scenario: Conversation agent has the PubChem tools

- **WHEN** the conversation agent is created
- **THEN** its script tools include `pubchemTool`, and its tools do not
