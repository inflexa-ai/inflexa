## MODIFIED Requirements

### Requirement: Unknown tool names fail at composition time

`createSandboxAgent` MUST throw at composition time when `meta.tools` names a `SandboxToolName` that the registry does not realize. One member is the exception: `knowledgeTemplate` MUST resolve to nothing when the embedder binds no knowledge client or the agent holds no mutator, because absence of the knowledge plane is the default state of the open-source host and never a wiring fault.

#### Scenario: An unknown name throws

- **GIVEN** an agent meta that names a tool with no realization
- **WHEN** the agent is built
- **THEN** construction throws and names the tool

#### Scenario: The template tool is absent without a client

- **GIVEN** an agent meta that names `knowledgeTemplate` and deps without a knowledge client
- **WHEN** the agent is built
- **THEN** construction succeeds and the tool list holds no `knowledge_template`
