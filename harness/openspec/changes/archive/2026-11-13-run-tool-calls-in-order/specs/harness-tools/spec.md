## ADDED Requirements

### Requirement: A tool declares that its calls can run at the same time

A tool definition MUST declare `concurrent: true` when a call of the tool can run at the same time as each other call. A tool that changes no state, for example a read of the workspace or a lookup, is such a tool. When a definition does not declare it, the packaged tool MUST NOT be concurrent.

#### Scenario: A tool with no declaration is not concurrent

- **WHEN** a tool is constructed with no `concurrent` field
- **THEN** the packaged `Tool` is not concurrent

### Requirement: A tool that starts a workflow is concurrent

A tool that declares `startsWorkflow: true` MUST also declare `concurrent: true`. The call must start its child workflow before its first `await`, thus it cannot wait for its turn. `defineTool` MUST throw at construction for a definition that breaks this rule.

#### Scenario: A tool that starts a workflow and is not concurrent

- **WHEN** a tool is constructed with `startsWorkflow: true` and no `concurrent: true`
- **THEN** construction throws, and the error names the tool

## MODIFIED Requirements

### Requirement: ToolContext carries only request-scoped values

The `ToolContext` passed to `execute` MUST be exactly
`{ invocationId, session, signal, emit, callLock, turnUsage, script }`. `invocationId` MUST be
the stable AI SDK tool-call id for this dispatch. It is the same when the same
call is delivered again, and it is different for a new model-issued call.

`callLock` is the lock of the series of requests that dispatched the call. The
loop runs each call that is not concurrent under it. `run_script` gives it to
each nested call, thus a nested call obeys the same order.

`turnUsage` is the optional turn-scoped usage accumulator of the
llm-usage-accounting capability. It is a call-scoped value that the dispatching
loop owns, present so a sub-agent-running tool can give it to the child
`runLoop`. It is request-scoped state, not an injected dependency, and a tool
that runs no sub-agent ignores it.

`script` is the code of the script that makes the call. It is present only for
a nested call of `run_script`.

`ToolContext` MUST NOT carry a durability seam, a database pool, a sandbox
client, a logger, or any other injected dependency.

#### Scenario: ToolContext exposes only request-scoped handles

- **GIVEN** the `ToolContext` type for a regular tool
- **WHEN** a tool's `execute` is typed against it
- **THEN** only `invocationId`, `session`, `signal`, `emit`, `callLock`, `turnUsage`, and `script` are reachable
- **AND** `runStep` is not reachable

#### Scenario: An approval is denied by default when unwired

- **GIVEN** a loop with no approver, and a tool whose `approval` hook gives a request
- **WHEN** the model calls the tool
- **THEN** the loop denies the call, and the tool does not wait indefinitely

#### Scenario: Invocation id comes from the dispatched tool call

- **GIVEN** an AI SDK tool call with `toolCallId = "call-7"`
- **WHEN** the loop constructs the context for that dispatch
- **THEN** `ctx.invocationId` equals `"call-7"`
