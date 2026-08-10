## MODIFIED Requirements

### Requirement: The harness owns type→agent selection through a registry built at assembly

`assembleCoreRuntime` MUST build a type-keyed registry of the agents it assembles. It MUST expose resolution on `CoreRuntime` (`agents.forThread(type)`) as the only way to reach an agent by thread type. The `conversation` type MUST resolve to the assembled conversation agent. The `report` type MUST resolve to the assembled Report Builder agent.

The registry MUST stay the single registration point for every typed agent. Thus the agent of a new thread type registers at assembly, with no embedder change. The resolution surface types MUST be re-exported from the package barrel.

#### Scenario: The conversation type resolves to the conversation agent

- **WHEN** `assembleCoreRuntime` returns and the caller resolves `agents.forThread("conversation")`
- **THEN** the result is ok and carries the same conversation `AgentDefinition` the assembly built

#### Scenario: The report type resolves to the Report Builder agent

- **WHEN** `assembleCoreRuntime` returns and the caller resolves `agents.forThread("report")`
- **THEN** the result is ok and carries the same Report Builder `AgentDefinition` the assembly built

#### Scenario: An embedder reaches resolution through the package barrel

- **WHEN** an embedder imports from `@inflexa-ai/harness`
- **THEN** the resolution surface and its error type are importable from the barrel, without a deep path

### Requirement: An unregistered type refuses with a typed error

Resolution MUST be synchronous. It MUST refuse a `ThreadType` with no registered agent through the `unregistered_thread_type` error variant on the `Result` error channel, never by a throw. The variant carries the refused `threadType`. The error channel is permanent: registration of an agent for every current member MUST NOT narrow the signature. Thus a future member never forces an agent registration in the same commit.

#### Scenario: A registry without an entry refuses with the typed error

- **GIVEN** a resolver built over a registry that holds no entry for a thread type
- **WHEN** the caller resolves that type
- **THEN** the result is an error of type `unregistered_thread_type` that carries the refused type
