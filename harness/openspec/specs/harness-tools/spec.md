# harness-tools Specification

## Purpose

Define the harness's tool primitive — the single dependency-agnostic
`defineTool` constructor, the name→tool registry that emits AI SDK-compatible
tool definitions, and the `ToolContext` of request-scoped values handed to
every `execute`. It fixes one error contract for all tools (expected outcomes
are `ok` data variants; unexpected failures are `err(ToolError)` or a throw) so
the loop owns the model-visible error envelope once. It also covers input
sanitization — unicode normalization and redaction of structured, prefixed
secret formats — applied to incoming user messages without false-positiving on
biological sequences.

**Tools own their durability through a declared execution mode.** Every tool
declares or defaults to `executionMode: "step" | "workflow" | "inline"`. A
`step` tool runs through a deterministic durable step wrapper, which preserves
replay caching, idempotency, and `operation_outputs` recording for the ~35
external bio/chem API tools and the workspace read tools at zero per-tool
cost — on replay those rate-limited, keyed external calls return cached instead
of re-firing. But that runs the body in DBOS *step* context, where `DBOS.recv`
is illegal and throws. The sandbox mutate tools (`execute_command`,
`write_file`, `edit_file`) submit a command and then `DBOS.recv` its result, so
each declares `executionMode: "workflow"`: it runs through a workflow-backed
execution path where its `recv` is legal, and the tool owns its own durability
(the submit is an idempotent step, the recv is a body call). `inline` is
reserved for pure deterministic logic with no external side effects. The mode
is the tool's declaration of intent, not loop policy; `ToolContext` carries a
`runStep` seam so any tool can wrap its own durable work under the tool's step
name.

## Requirements

### Requirement: Tools are defined through a dependency-agnostic primitive

`defineTool({ id, description, inputSchema, execute, executionMode })` SHALL package a `Tool` and emit an AI SDK-compatible tool definition from the Zod `inputSchema`. `defineTool` SHALL NOT take or carry dependencies. A tool that needs dependencies SHALL be a factory closure that captures them and calls `defineTool`.

#### Scenario: A flat-object schema emits a valid AI SDK input schema

- **GIVEN** a `defineTool` call whose `inputSchema` is a Zod object
- **WHEN** the tool is constructed
- **THEN** the emitted tool definition has an object input schema accepted by AI SDK

#### Scenario: A union-shaped schema is rejected at construction

- **GIVEN** a `defineTool` call whose `inputSchema` is a `z.discriminatedUnion`
- **WHEN** the tool is constructed
- **THEN** construction throws, identifying that the schema cannot be represented as the required top-level object tool input

### Requirement: ToolContext carries only request-scoped values

The `ToolContext` passed to `execute` SHALL be exactly `{ session, signal, emit, runStep, ask }` unless a workflow-backed wrapper explicitly provides a narrower workflow execution context for its own implementation. `runStep` is the durability seam a step-backed tool uses to wrap durable work (`passthroughStep` in chat, `DBOS.runStep` in workflows). `ask` is the user-approval seam a conversation tool uses to pause for an explicit user decision (see the tool-approval spec); it resolves to a deny-by-default realization when the embedder wires none, so a tool that calls it in a non-interactive context is denied rather than left waiting. `ToolContext` SHALL NOT carry a database pool, sandbox client, logger, or any other injected dependency.

#### Scenario: ToolContext exposes only request-scoped handles

- **GIVEN** the `ToolContext` type for a regular tool
- **WHEN** a tool's `execute` is typed against it
- **THEN** only `session`, `signal`, `emit`, `runStep`, and `ask` are reachable

#### Scenario: ask resolves to deny-by-default when unwired

- **GIVEN** a `ToolContext` built with no approval realization wired
- **WHEN** a tool calls `ctx.ask`
- **THEN** the call is denied by the default realization and the tool does not suspend indefinitely

### Requirement: Tools declare an execution mode

Every tool SHALL declare or default to an execution mode: `step`, `workflow`, or `inline`. A `step` tool SHALL run through a deterministic durable step wrapper. A `workflow` tool SHALL run through a workflow-backed execution path when it requires body-only DBOS operations or multiple durable operations. An `inline` tool SHALL be reserved for pure deterministic logic with no external side effects.

#### Scenario: Default external tool is step-backed

- **WHEN** an external lookup tool is constructed without a special mode
- **THEN** it runs as a `step` tool through the deterministic durable wrapper

#### Scenario: Sandbox mutate tool is workflow-backed

- **WHEN** `execute_command`, `write_file`, or `edit_file` is constructed
- **THEN** it declares `executionMode: "workflow"`

#### Scenario: Inline mode is pure only

- **WHEN** a tool declares `executionMode: "inline"`
- **THEN** review and tests verify it has no external side effects and does not require DBOS durability

### Requirement: AI SDK tool wrappers preserve the tool error contract

AI SDK tool wrappers SHALL preserve the existing harness tool error contract: expected outcomes are `ok` data variants, unexpected failures are `err(ToolError)` or throws, and the loop maps failures into model-visible error tool results. The `ok` output SHALL NOT carry a generic `success` boolean or error field.

#### Scenario: A not-found result is returned as data

- **GIVEN** a gene-lookup tool queried for a non-existent symbol
- **WHEN** the AI SDK tool wrapper executes it
- **THEN** it returns an `ok` data result and does not mark the tool call as an error

#### Scenario: An upstream failure surfaces as a tool error

- **GIVEN** a tool whose external API returns 503
- **WHEN** the AI SDK tool wrapper executes it
- **THEN** it throws or returns an error result that the loop maps to a model-visible error tool result

### Requirement: Tools distinguish expected outcomes from unexpected failures

A tool's `execute` SHALL return `Promise<Result<Output, ToolError>>`. Expected outcomes — including "not found", "empty", and "ambiguous" — SHALL be `ok` data variants of `Output`, never an error. An unexpected failure (network, upstream 5xx, timeout) SHALL be an `err(ToolError)` or a throw; the loop maps both to one `tool_result { is_error: true }`. The `ok` `Output` SHALL NOT carry a `success` boolean or an `error` field.

#### Scenario: A not-found result is returned as data

- **GIVEN** a gene-lookup tool queried for a non-existent symbol
- **WHEN** `execute` runs
- **THEN** it returns `ok` whose `notFound` list contains that symbol, and does not error

#### Scenario: An upstream failure surfaces as an error, not a success value

- **GIVEN** a tool whose external API returns 503
- **WHEN** `execute` runs
- **THEN** it throws or returns `err(ToolError)` rather than an `ok` carrying `{ success: false }`

#### Scenario: A response that violates the expected schema surfaces as an unexpected failure

- **GIVEN** a bio-API tool that fetches a JSON response through the schema-validating fetch helper (`apiFetchValidated`)
- **WHEN** the upstream returns a payload whose shape or field types do not match the declared Zod schema (a changed contract, or an error envelope where data was expected)
- **THEN** the fetch resolves to an unexpected `invalid_response` `ApiError` — which the tool surfaces as an error rather than mapping malformed data into an `ok` result. A partial-but-valid response (fields the schema marks optional are absent) still parses and is handled as data.

### Requirement: Input sanitization redacts secrets without corrupting biological sequences

`redactSecrets` SHALL redact structured, prefixed secret formats (`AKIA…`, `sk-ant-…`, `sk-…`, `gh[psoru]_…`, `eyJ…` JWTs, `Bearer …`, database connection URIs). It SHALL NOT use the 40-character generic pattern or a loose `key:value` pattern, because those false-positive on nucleotide and protein sequences.

#### Scenario: A prefixed API key is redacted

- **GIVEN** user input containing an `sk-ant-` API key
- **WHEN** `redactSecrets` runs
- **THEN** the key is replaced with a redaction marker

#### Scenario: A 40-character DNA sequence is not redacted

- **GIVEN** user input containing a 40-nucleotide `ACGT…` string
- **WHEN** `redactSecrets` runs
- **THEN** the sequence passes through unchanged
