## MODIFIED Requirements

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

The `ToolContext` passed to `execute` SHALL be exactly `{ session, signal, emit, runStep }` unless a workflow-backed wrapper explicitly provides a narrower workflow execution context for its own implementation. `runStep` is the durability seam a step-backed tool uses to wrap durable work (`passthroughStep` in chat, `DBOS.runStep` in workflows). `ToolContext` SHALL NOT carry a database pool, sandbox client, logger, or any other injected dependency.

#### Scenario: ToolContext exposes only request-scoped handles

- **GIVEN** the `ToolContext` type for a regular tool
- **WHEN** a tool's `execute` is typed against it
- **THEN** only `session`, `signal`, `emit`, and `runStep` are reachable

## REMOVED Requirements

### Requirement: A tool opts out of the loop's step wrap with bodyContext

**Reason**: `bodyContext` is an old-loop partition flag. AI SDK integration needs explicit execution modes that describe durability ownership instead of asking the loop to run selected tools unwrapped in the workflow body.

**Migration**: Replace `bodyContext` with `executionMode: "step" | "workflow" | "inline"`. Convert `execute_command`, `write_file`, and `edit_file` to workflow-backed tools.

## ADDED Requirements

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
