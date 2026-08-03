# harness-runtime Delta

## MODIFIED Requirements

### Requirement: The embedding imports through the harness barrel

Cli code SHALL import harness symbols only from the `@inflexa-ai/harness` barrel. The
barrel SHALL be extended (additive exports only) with the embedder runtime surface the
cli consumes: DBOS lifecycle (`launchDbos`, `shutdownDbos`, `DbosConfig`),
data-profile registration and trigger (with their dep/param/result types),
`StagedInput`, the sandbox client factory and its config types, the workspace
filesystem factory, the exec-callback envelope helpers (`workflowIdFromExec`,
envelope/done-marker types), the run-engine surface: sandbox-step and
execute-analysis registration (with dep/input/result and agent-build context types),
the sandbox agent catalog factory, plan schema and validation (`AnalysisPlanSchema`,
`validatePlan`), plan persistence (`upsertPlan`, `loadPlan`), run
state (insert/query/update run rows, step-execution queries, the dedup-collision
error), the run launcher, and the scheduled-workflow registration functions; the
provider error surface (`ProviderError`, `toProviderError`); and the conversation
surface: the composition root and its dep types (`assembleCoreRuntime`, the
`CoreRuntimeDeps` family), the thread-agent resolution surface (`ThreadAgentResolver`,
`UnregisteredThreadType`, the `ThreadType` vocabulary), the chat-turn preparation and
persistence functions with their types (`prepareChatTurn`, the thread store/history
factories, `StoredMessage`), the history display readers (`contentToCortexMessages`,
`createCardResolver`), the streaming-chat provider wrapper (`createStreamingChat`) and
`AgentChat`, the pass-through run step (`passthroughStep`), the ephemeral pre-launch
sweep (`sweepEphemeralWorkflows`), the unavailable preview publisher, and the
`contracts/` chat-event and chat-part types.

#### Scenario: No deep imports in cli code

- **WHEN** the cli's harness-facing modules are inspected
- **THEN** every harness import resolves from the package barrel, none from deep subpaths

#### Scenario: The turn engine reaches the resolver through the barrel

- **WHEN** the turn engine types its resolver argument and its refusal outcome
- **THEN** `ThreadAgentResolver` and `UnregisteredThreadType` resolve from the package barrel
