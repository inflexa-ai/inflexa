## ADDED Requirements

### Requirement: A tool ok value can carry a call record

A tool MUST give each effect on process-local state as a call record, not as a
side effect of its `execute`. A replay of a step-mode call returns the cached
result, and it does not run `execute` again. Thus a side effect of the body is
lost on recovery. The lineage collector of a sandbox step is one example of such
state.

`withToolCallRecord(value, record)` MUST attach a record to an ok value under a
reserved symbol key, and the value MUST keep its own fields. `JSON.stringify`
omits a symbol key, thus the model never reads the record. The record MUST be
plain JSON, because the step cache serializes it.

A tool that attaches records MUST declare `foldCallRecord(record)`. The loop
calls the fold after the call settles (see the harness-agent-loop spec). The fold
MUST be synchronous. A failed call and an ok value with no record MUST reach no
fold. A throw of the fold MUST NOT fail the call, because the call settled
already. The loop logs the throw.

#### Scenario: The model does not read the record

- **GIVEN** a tool whose ok value carries a call record
- **WHEN** the loop sends the tool result to the model
- **THEN** the result text holds the fields of the value and holds no field of the record

#### Scenario: A replayed call folds its record again

- **GIVEN** a step-mode call whose ok value carried a record, and a workflow that recovers in a new process
- **WHEN** the loop replays the call from the step cache
- **THEN** the tool does not run `execute` again
- **AND** the loop gives the cached record to `foldCallRecord`

#### Scenario: A failed fold does not fail the call

- **GIVEN** a `foldCallRecord` that throws
- **WHEN** the loop folds the record
- **THEN** the loop logs the throw, and the tool result stays the result of the call

### Requirement: Each tool runs in the step mode or the inline mode

Each tool MUST declare or default to an execution mode: `step` or `inline`. A
`step` tool MUST run through a deterministic durable step wrapper, which caches
the whole call. `step` is the default. An `inline` tool runs with no step, and
it is reserved for logic whose effects are not durable work.

`execute_command`, `write_file`, and `edit_file` MUST run in the `step` mode.
The sandbox exec of `execute_command` runs inside the step of the tool call (see
the harness-sandbox-exec spec). A replay returns the cached result. Thus each of
the three tools gives its effect on process-local state as a call record.

#### Scenario: Default external tool is step-backed

- **WHEN** an external lookup tool is constructed without a special mode
- **THEN** it runs as a `step` tool through the deterministic durable wrapper

#### Scenario: Mutate-surface tool is step-backed

- **WHEN** `execute_command`, `write_file`, or `edit_file` is constructed
- **THEN** it runs as a `step` tool

#### Scenario: Inline mode is not durable work

- **WHEN** a tool declares `executionMode: "inline"`
- **THEN** review and tests make sure that it does no durable work

#### Scenario: The workflow mode does not exist

- **WHEN** a tool declares `executionMode: "workflow"`
- **THEN** the typecheck fails

## MODIFIED Requirements

### Requirement: ToolContext carries only request-scoped values

The `ToolContext` passed to `execute` MUST be exactly
`{ session, signal, emit, ask, invocationId, turnUsage }`. `invocationId` MUST be
the stable AI SDK tool-call id for this dispatch. It is the same when the same
call is delivered again, and it is different for a new model-issued call.

`ask` is the user-approval seam a conversation tool uses to pause for an
explicit user decision (see the tool-approval spec). When the embedder wires
none, it resolves to a deny-by-default realization. Thus a tool that calls it in
a non-interactive context gets a denial and does not wait.

`turnUsage` is the optional turn-scoped usage accumulator of the
llm-usage-accounting capability. It is a call-scoped value that the dispatching
loop owns, present so a sub-agent-running tool can give it to the child
`runAgent`. It is request-scoped state, not an injected dependency, and a tool
that runs no sub-agent ignores it.

`ToolContext` MUST NOT carry a durability seam, a database pool, a sandbox
client, a logger, or any other injected dependency.

#### Scenario: ToolContext exposes only request-scoped handles

- **GIVEN** the `ToolContext` type for a regular tool
- **WHEN** a tool's `execute` is typed against it
- **THEN** only `session`, `signal`, `emit`, `ask`, `invocationId`, and `turnUsage` are reachable
- **AND** `runStep` is not reachable

#### Scenario: ask resolves to deny-by-default when unwired

- **GIVEN** a `ToolContext` built with no approval realization wired
- **WHEN** a tool calls `ctx.ask`
- **THEN** the call is denied by the default realization and the tool does not suspend indefinitely

#### Scenario: Invocation id comes from the dispatched tool call

- **GIVEN** an AI SDK tool call with `toolCallId = "call-7"`
- **WHEN** the loop constructs the context for that dispatch
- **THEN** `ctx.invocationId` equals `"call-7"`

## REMOVED Requirements

### Requirement: Tools declare an execution mode

**Reason**: The `workflow` mode is removed, and the mutate tools run in the `step` mode.

**Migration**: Refer to "Each tool runs in the step mode or the inline mode". A tool that declared `executionMode: "workflow"` drops the field, and it gives each effect on process-local state as a call record.
