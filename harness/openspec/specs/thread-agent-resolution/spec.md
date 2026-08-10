# thread-agent-resolution Specification

## Purpose

Define how a thread's type selects the agent that runs its turns. The selection
rule is harness-owned. `assembleCoreRuntime` builds a type-keyed registry of the
agents it assembles, and it exposes resolution as `CoreRuntime.agents`
(`ThreadAgentResolver`, `src/runtime/assemble.ts`). An embedder plumbs the type
of a thread into `forThread`, and it never maps a type to an agent itself.

The registry is the single registration point for every typed agent. It holds the
conversation agent and the Report Builder agent. The agent of a later thread
type plugs in at assembly, with no embedder change. `prepareChatTurn` surfaces
the type from the row it already loads, so the turn path learns it at zero extra
query cost.

## Requirements

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

### Requirement: Resolution returns assembled singletons

Resolution MUST return the same assembled `AgentDefinition` object on every call for a given type, never a per-call reconstruction. Thus a reference captured at construction time (a delegating provider handle, a closure-wired tool) stays valid across every turn.

#### Scenario: Repeated resolution yields one identity

- **WHEN** `agents.forThread("conversation")` is called twice on one `CoreRuntime`
- **THEN** both calls return the identical object

### Requirement: An unregistered type refuses with a typed error

Resolution MUST be synchronous. It MUST refuse a `ThreadType` with no registered agent through the `unregistered_thread_type` error variant on the `Result` error channel, never by a throw. The variant carries the refused `threadType`. The error channel is permanent: registration of an agent for every current member MUST NOT narrow the signature. Thus a future member never forces an agent registration in the same commit.

#### Scenario: A registry without an entry refuses with the typed error

- **GIVEN** a resolver built over a registry that holds no entry for a thread type
- **WHEN** the caller resolves that type
- **THEN** the result is an error of type `unregistered_thread_type` that carries the refused type

### Requirement: prepareChatTurn surfaces the thread's type

`prepareChatTurn` MUST include the `threadType` of the thread on its `ok` result. The value comes from the thread row that the ownership step already loads. For a thread that it creates, the value is the type that it created. Thus a caller resolves the agent of the turn without a second thread read.

#### Scenario: An existing thread reports its stored type

- **GIVEN** a thread row whose `thread_type` is `conversation`
- **WHEN** `prepareChatTurn` prepares a turn on that thread
- **THEN** the `ok` result carries `threadType: "conversation"`

#### Scenario: A first-turn thread reports the type it was created with

- **GIVEN** a `threadId` with no row
- **WHEN** `prepareChatTurn` prepares the turn and creates the thread
- **THEN** the `ok` result carries `threadType: "conversation"`, matching the created row

#### Scenario: A report thread reports its stored type

- **GIVEN** a thread row whose `thread_type` is `report`, written directly through the store (no production path creates one yet)
- **WHEN** `prepareChatTurn` prepares a turn on that thread
- **THEN** the `ok` result carries `threadType: "report"`
