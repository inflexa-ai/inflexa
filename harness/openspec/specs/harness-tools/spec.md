# harness-tools Specification

## Purpose

Define the harness's tool primitive — the single dependency-agnostic
`defineTool` constructor, the name→tool registry that emits Anthropic tool
definitions, and the `ToolContext` of request-scoped values handed to every
`execute`. It fixes one error contract for all tools (expected outcomes are
`ok` data variants; unexpected failures are `err(ToolError)` or a throw) so the
loop owns the `is_error` envelope once. It also covers input sanitization —
unicode normalization and redaction of structured, prefixed secret formats —
applied to incoming user messages without false-positiving on biological
sequences.

**Tools own their durability; the loop default-wraps with a `bodyContext`
opt-out.** The loop wraps each tool's `execute` in a `runStep`, which preserves
replay caching, idempotency, and `operation_outputs` recording for the ~35
external bio/chem API tools and the workspace read tools at zero per-tool
cost — on replay those rate-limited, keyed external calls return cached instead
of re-firing. But that runs the body in DBOS *step* context, where `DBOS.recv`
is illegal and throws. The sandbox mutate tools (`execute_command`,
`write_file`, `edit_file`) submit a command and then `DBOS.recv` its result, so
each declares `bodyContext: true` to opt out: the loop runs it unwrapped in the
workflow body, where its `recv` is legal, and the tool owns its own durability
(the submit is an idempotent step, the recv is a body call). The flag is the
tool's declaration of intent, not loop policy; `ToolContext` carries a `runStep`
seam so any tool can wrap its own durable work under the tool's step name.

## Requirements

### Requirement: Tools are defined through a dependency-agnostic primitive

`defineTool({ id, description, inputSchema, execute })` SHALL package a `Tool` and emit its Anthropic `input_schema` from the Zod `inputSchema` via `z.toJSONSchema()`. `defineTool` SHALL NOT take or carry dependencies. A tool that needs dependencies SHALL be a factory closure that captures them and calls `defineTool`.

#### Scenario: A flat-object schema emits a valid Anthropic input schema

- **GIVEN** a `defineTool` call whose `inputSchema` is a Zod object
- **WHEN** the tool is constructed
- **THEN** the emitted `input_schema` has a top-level `"type": "object"`

#### Scenario: A union-shaped schema is rejected at construction

- **GIVEN** a `defineTool` call whose `inputSchema` is a `z.discriminatedUnion`
- **WHEN** the tool is constructed
- **THEN** construction throws, identifying the missing top-level `"type": "object"`

### Requirement: ToolContext carries only request-scoped values

The `ToolContext` passed to `execute` SHALL be exactly `{ session, signal, emit, runStep }`. `runStep` is the durability seam a tool uses to wrap its own durable work (`passthroughStep` in chat, `DBOS.runStep` in workflows); the loop namespaces its name under the tool's own step name. `ToolContext` SHALL NOT carry a database pool, sandbox client, logger, or any other injected dependency.

#### Scenario: ToolContext exposes only request-scoped handles

- **GIVEN** the `ToolContext` type
- **WHEN** a tool's `execute` is typed against it
- **THEN** only `session`, `signal`, `emit`, and `runStep` are reachable — no pool, sandbox client, or logger

### Requirement: A tool opts out of the loop's step wrap with bodyContext

A tool MAY declare `bodyContext: true` on `defineTool` to opt out of the loop's default `runStep` wrap, so the loop runs it unwrapped in the workflow body. A tool whose `execute` makes a body-only DBOS call (`DBOS.recv`/`DBOS.writeStream`) SHALL declare the flag; without it the call would throw in step context. An unset/false flag SHALL keep the wrap so the tool's result caches on replay. Exactly the sandbox mutate tools (`execute_command`, `write_file`, `edit_file`) carry it.

#### Scenario: A bodyContext tool is constructed unwrapped

- **GIVEN** a `defineTool` call with `bodyContext: true`
- **WHEN** the tool is constructed
- **THEN** the resulting `Tool` carries `bodyContext: true`, signalling the loop to run it unwrapped in the workflow body

#### Scenario: A default tool keeps the step wrap

- **GIVEN** a `defineTool` call that omits `bodyContext`
- **WHEN** the tool is constructed
- **THEN** the `Tool` has no `bodyContext` flag and the loop wraps its dispatch in `runStep`

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
