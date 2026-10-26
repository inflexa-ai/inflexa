## ADDED Requirements

### Requirement: The loop internals are not on the root barrel

The root barrel MUST NOT carry `runAgent`, `RunStep`, `passthroughStep`, `durableStep`, `createStreamingChat`, or `AgentChat`. No embedder drives the loop. An embedder opens and runs a chat turn, renders the frames of the wire contract, and defines host tools. The release notes MUST name each removed name.

#### Scenario: A removed name does not resolve

- **WHEN** an embedder imports `runAgent` from `@inflexa-ai/harness`
- **THEN** the import fails to compile

### Requirement: The root barrel carries the surface of an embedder

The root barrel MUST carry the opening and the run of a chat turn, and the wire contracts of the chat frames. It MUST also carry `defineTool`, `ToolContext`, and the model factory of the composition root. A host tool that `defineTool` makes MUST NOT import a type of the AI SDK.

#### Scenario: A host tool needs no AI SDK type

- **WHEN** an embedder defines a host tool with `defineTool` from `@inflexa-ai/harness`
- **THEN** its code imports no name from `ai`
