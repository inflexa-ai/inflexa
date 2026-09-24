## ADDED Requirements

### Requirement: The composition root gives one tool output store to each loop

`assembleCoreRuntime` MUST make one tool output store, `createToolOutputStore(pool)`, over the application pool of its conversation deps. It MUST give that store to these consumers:

- the conversation agent, which gives it to its loop-driving tools
- the report agent
- the deps of the sandbox step
- the deps of `executeAnalysis`, which gives it to the run synthesis
- the deps of the data profile

`CoreWorkflowDeps` and `ConversationAssemblyDeps` MUST omit the field, the same as `usageRecorder`. Thus an embedder cannot wire a store that only a part of the agent tree uses.

The sandbox step MUST give the store to `SandboxAgentBuildContext` and to each loop that it runs. These loops are the task and the two post-step continuations. When the step has a store and the agent of `buildAgent` does not declare `read_tool_output`, the step MUST log one warn.

`runChatTurn` MUST give the root loop of a turn a store over the pool of its deps. `prepareChatTurn` makes the thread history over that pool in the same way. The realization holds no state apart from its table. Thus two instances over one pool read and write the same rows.

#### Scenario: The loops of a run share one table

- **GIVEN** a runtime that `assembleCoreRuntime` built
- **WHEN** a sandbox step and the run synthesis each cut a long result
- **THEN** each kept text lands in `cortex_tool_outputs` of the application pool, under the analysis of the run

#### Scenario: An embedder cannot give a store to one bag

- **WHEN** an embedder types a literal of `CoreWorkflowDeps` with a `toolOutputStore` field
- **THEN** the typecheck fails

#### Scenario: An agent that lacks the read tool is reported

- **GIVEN** an embedder whose `buildAgent` gives the store to no agent
- **WHEN** a sandbox step runs
- **THEN** the step logs one warn, and its loop keeps no text

#### Scenario: A chat turn keeps the text of its root loop

- **GIVEN** a chat turn whose tool gives a result of 50,000 characters
- **WHEN** `runChatTurn` runs the turn
- **THEN** the stored round holds the excerpt, and `cortex_tool_outputs` holds the whole text under the reference of the excerpt
