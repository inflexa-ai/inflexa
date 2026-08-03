# thread-agent-resolution Specification

## Purpose

Define how a thread's type selects the agent that runs its turns. The selection
rule is harness-owned: `assembleCoreRuntime` builds a type-keyed registry of the
agents it assembles and exposes resolution as `CoreRuntime.agents`
(`ThreadAgentResolver`, `src/runtime/assemble.ts`), so an embedder plumbs a
thread's type into `forThread` and never maps types to agents itself. The
registry is the single registration point for every typed agent — a future
thread type's agent (e.g. the Report Builder) plugs in at assembly with no
embedder change. `prepareChatTurn` surfaces the type from the row it already
loads, so the turn path learns it at zero extra query cost.

## Requirements

### Requirement: The harness owns type→agent selection through a registry built at assembly

`assembleCoreRuntime` SHALL build a type-keyed registry of the agents it assembles and expose resolution on `CoreRuntime` (`agents.forThread(type)`) as the only way to reach an agent by thread type. The `conversation` type SHALL resolve to the assembled conversation agent. The registry SHALL be the single registration point for every future typed agent, so a new thread type's agent plugs in at assembly with no embedder change, and the resolution surface types SHALL be re-exported from the package barrel.

#### Scenario: The conversation type resolves to the conversation agent

- **WHEN** `assembleCoreRuntime` returns and the caller resolves `agents.forThread("conversation")`
- **THEN** the result is ok and carries the same conversation `AgentDefinition` the assembly built

#### Scenario: An embedder reaches resolution through the package barrel

- **WHEN** an embedder imports from `@inflexa-ai/harness`
- **THEN** the resolution surface and its error type are importable from the barrel, without a deep path

### Requirement: Resolution returns assembled singletons

Resolution SHALL return the same assembled `AgentDefinition` object on every call for a given type, never a per-call reconstruction, so references captured at construction time (an embedder's delegating provider handles, closure-wired tools) stay valid across every turn.

#### Scenario: Repeated resolution yields one identity

- **WHEN** `agents.forThread("conversation")` is called twice on one `CoreRuntime`
- **THEN** both calls return the identical object

### Requirement: An unregistered type refuses with a typed error

Resolution SHALL be synchronous and SHALL refuse a `ThreadType` with no registered agent by returning the `unregistered_thread_type` error variant — carrying the refused `threadType` — on the `Result` error channel, never by throwing. The error channel is permanent: registration of an agent for every current `ThreadType` member SHALL NOT narrow the signature, so adding a future member never forces an agent registration in the same commit.

#### Scenario: The report type refuses before its agent exists

- **GIVEN** a `CoreRuntime` assembled with no `report` agent registered
- **WHEN** the caller resolves `agents.forThread("report")`
- **THEN** the result is an error of type `unregistered_thread_type` with `threadType: "report"`

### Requirement: prepareChatTurn surfaces the thread's type

`prepareChatTurn` SHALL include the thread's `threadType` on its `ok` result, read from the thread row its ownership check already loads — or, for a thread it creates, the type it created — so a caller resolves the turn's agent without a second thread read.

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
