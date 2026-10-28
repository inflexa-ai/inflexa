# Spec Delta

## MODIFIED Requirements

### Requirement: ChEMBL tools are available via the per-agent allowlist

The ChEMBL tool `chembl` MUST be an entry in the central sandbox tool registry
that `resolveSandboxTools` (`harness/src/agents/sandbox/shared.ts`) resolves. It
reaches a sandbox agent only when the `meta.tools` allowlist of that agent names
it. It MUST also be a script tool of the conversation agent
(`harness/src/agents/conversation-agent.ts`), which calls it from `run_script`
(refer to the script-tools capability). It MUST NOT be a member of
`BASE_SANDBOX_TOOLS`, thus it is not granted to each sandbox agent.

#### Scenario: Sandbox agent resolves ChEMBL tools from its allowlist

- **WHEN** a sandbox-agent meta lists `chembl` in `meta.tools`
- **THEN** `createSandboxAgent` resolves it through `resolveSandboxTools` and adds it to the tool array of that agent

#### Scenario: ChEMBL tools are not granted by default

- **WHEN** the `meta.tools` of a sandbox agent does not name `chembl`
- **THEN** the resolved tool array does not contain `chembl`

#### Scenario: Conversation agent has the ChEMBL tools

- **WHEN** the conversation agent is created
- **THEN** its script tools include `chemblTool`, and its tools do not
