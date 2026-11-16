## REMOVED Requirements

### Requirement: The bio-tool key slice is importable from the root

**Reason**: `BioToolKeys` is gone. The harness reads each credential through `AgentCatalog.credential(name)` when it builds an agent.

**Migration**: an embedder gives the credentials through its `AgentCatalog`, and the connector settings name each credential.

## ADDED Requirements

### Requirement: The catalog types are importable from the root

The harness MUST export these names from `src/index.ts`: `AgentCatalog`, `AgentEntry`, `CustomAgent`, `AgentAttachments`, `BuiltinAgentId`, `SkillStore`, `SkillInfo`, `McpServerConfig` and `ConnectorSettings`. It MUST also export the list of the connector ids and the release defaults of each built-in agent. Thus a host can build a catalog and show the defaults without a deep import.

#### Scenario: An embedder builds a catalog from the root

- **GIVEN** an embedder that implements `AgentCatalog`
- **WHEN** it names each type of the catalog
- **THEN** it imports each name from `@inflexa-ai/harness`

#### Scenario: A host lists the connectors

- **WHEN** a host shows the connectors that a user can attach
- **THEN** it reads the connector ids and descriptions from `@inflexa-ai/harness`
