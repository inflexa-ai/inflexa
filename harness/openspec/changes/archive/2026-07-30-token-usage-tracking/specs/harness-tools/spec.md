# harness-tools Specification (delta)

## MODIFIED Requirements

### Requirement: ToolContext carries only request-scoped values

The `ToolContext` passed to `execute` SHALL be exactly
`{ session, signal, emit, runStep, ask, invocationId, turnUsage }` unless a workflow-backed
wrapper explicitly provides a narrower workflow execution context for its own
implementation. `invocationId` SHALL be the stable AI SDK tool-call id for this
dispatch, identical when the same call is redelivered and distinct for a new
model-issued call. `runStep` is the durability seam a step-backed tool uses to
wrap durable work (`passthroughStep` in chat, `DBOS.runStep` in workflows).
`ask` is the user-approval seam a conversation tool uses to pause for an
explicit user decision (see the tool-approval spec); it resolves to a
deny-by-default realization when the embedder wires none, so a tool that calls
it in a non-interactive context is denied rather than left waiting.
`turnUsage` is the optional turn-scoped usage accumulator of the llm-usage-accounting
capability — a call-scoped value the dispatching loop owns, present so a
sub-agent-running tool can hand it to the child `runAgent`; it is request-scoped
state, not an injected dependency, and a tool that runs no sub-agent ignores it.
`ToolContext` SHALL NOT carry a database pool, sandbox client, logger, or any
other injected dependency.

#### Scenario: ToolContext exposes only request-scoped handles

- **GIVEN** the `ToolContext` type for a regular tool
- **WHEN** a tool's `execute` is typed against it
- **THEN** only `session`, `signal`, `emit`, `runStep`, `ask`, `invocationId`, and `turnUsage` are reachable

#### Scenario: ask resolves to deny-by-default when unwired

- **GIVEN** a `ToolContext` built with no approval realization wired
- **WHEN** a tool calls `ctx.ask`
- **THEN** the call is denied by the default realization and the tool does not suspend indefinitely

#### Scenario: Invocation id comes from the dispatched tool call

- **GIVEN** an AI SDK tool call with `toolCallId = "call-7"`
- **WHEN** the loop constructs the context for that dispatch
- **THEN** `ctx.invocationId` equals `"call-7"`
