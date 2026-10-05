## MODIFIED Requirements

### Requirement: execute_command is the single chokepoint for sandbox command execution

The harness MUST expose an `execute_command` tool as a dependency-bearing factory
`createExecuteCommandTool(deps)`. The factory captures a `SandboxClient`, the
live `SandboxRef`, and the step deadline. Its `execute` MUST be the **only** path
through which a model runs a command that it wrote. A tool, an agent, or a
workflow step MUST NOT POST to the `/exec` of sandbox-server directly. Each exec
goes through `SandboxClient.exec`. Thus the durability, the idempotency, and the
liveness that `SandboxClient` owns hold for each command (see the
harness-sandbox-exec spec). The factory MUST capture the `SandboxClient` at
construction (see the harness-durable-runtime spec), and never get it from an
ambient context.

The loop runs each call as one durable step. The `execute` MUST run one exec
through `SandboxClient.exec`, inside that step. Thus the exec id is the id of
the step, and a replay returns the cached result with no submit. The `execute`
MUST forward the sandbox events through `ctx.emit` for the live tool activity.
It MUST return the bounded `ExecResult` as a data variant.

The `execute` MUST default `cwd` to the in-sandbox working directory of the
agent. A relative `cwd` resolves against it, and an absolute `/{resourceId}/...`
`cwd` is used as it is. Thus the relative paths in a script agree with the
relative paths in the file tools. Only an unexpected failure MUST throw.

#### Scenario: ToolContext does not carry the SandboxClient

- **GIVEN** the harness `ToolContext` type
- **WHEN** an `execute_command` tool's `execute` is typed against it
- **THEN** the `SandboxClient` is not reachable through `ToolContext`, because the factory closure captures it

#### Scenario: execId is derived deterministically

- **GIVEN** an `execute_command` call that the loop runs as the step `5` of the workflow `wf1`
- **WHEN** `execute_command` runs
- **THEN** the exec id is `"wf1:5"`
- **AND** a replay of the call returns the cached step output and sends no request to the sandbox

#### Scenario: cwd defaults to the working directory

- **GIVEN** an `execute_command` call that omits `cwd`
- **WHEN** the command runs
- **THEN** it runs in the in-sandbox working directory of the agent
- **AND** the relative paths of a script match the relative paths of the file tools

#### Scenario: No other tool spawns sandbox work

- **GIVEN** the harness tool registry
- **WHEN** the registry is enumerated
- **THEN** `execute_command` is the only tool that runs a command that the model wrote
- **AND** no registered tool POSTs to the `/exec` of sandbox-server, and each exec goes through `SandboxClient.exec`

### Requirement: The mutate seam records file-tool provenance

The `WorkspaceMutator` seam MUST own write provenance the same way it owns
confinement. `createWorkspaceMutator` MUST accept the `ProvenanceCollector` of
the step as an optional construction-time dependency. `writeFile` MUST accept
the agent-visible name of the invoking tool (`write_file` or `edit_file`) and
the `invocationId` of the tool call, beside `path` and `content`.

The record and the write MUST be two calls. On a successful confined write,
`writeFile` MUST give back a write record: the analysis id, the path, the hash
and the size of the exact bytes that landed, the tool name, and the invocation
id. On each other outcome it MUST give back no record. `recordWrite(record)`
MUST record the write: the step realization calls `recordFileToolWrite` on its
collector, and the session realization emits the `write-file` session event.

The tool MUST carry the write record as its call record, and its
`foldCallRecord` MUST give the record to `recordWrite` (see the harness-tools
spec). Thus a replay of the call does not write the bytes again. The fold still
records the write into the state of the new process. When no collector
was supplied, the write MUST proceed with no change and record nothing.
`ToolContext` MUST NOT carry the collector.

#### Scenario: write_file passes its tool name through the chokepoint

- **WHEN** the model invokes `write_file` and the confined write succeeds
- **THEN** the seam records the artifact under `toolName: "write_file"` with the `invocationId` of the context
- **AND** the tool factory forwards the two values, and it never touches the collector itself

#### Scenario: edit_file records through the same seam

- **WHEN** the model invokes `edit_file` and its whole-content write succeeds
- **THEN** the same `mutator.writeFile` chokepoint gives the write record under `toolName: "edit_file"`, and the fold records it
- **AND** no second path records the write

#### Scenario: A replayed write records again with no second write

- **GIVEN** a `write_file` call that completed in a step, and a workflow that recovers in a new process
- **WHEN** the loop replays the call from the step cache
- **THEN** the mutator does not write the bytes again
- **AND** the fold records the cached write record into the collector of the new process

#### Scenario: A collector-less mutator writes without recording

- **GIVEN** a mutator constructed without a collector
- **WHEN** a write succeeds
- **THEN** the result of the write is unchanged and no provenance record exists
