## MODIFIED Requirements

### Requirement: Tools are defined through a dependency-agnostic primitive

`defineTool({ id, description, inputSchema, execute, executionMode, describeCall })` SHALL package a `Tool` and emit an AI SDK-compatible tool definition from the Zod `inputSchema`. `defineTool` SHALL NOT take or carry dependencies. A tool that needs dependencies SHALL be a factory closure that captures them and calls `defineTool`.

`describeCall` is OPTIONAL. When present it SHALL be a synchronous, pure `(input: z.infer<Schema>) => string` that names what this call is doing, and the packaged `Tool` SHALL carry it (see the tool-call-detail capability). It is the call-time counterpart of `description`: `description` self-describes the tool at attach time, and `describeCall` self-describes one invocation. A tool that omits it is fully valid.

#### Scenario: A flat-object schema emits a valid AI SDK input schema

- **GIVEN** a `defineTool` call whose `inputSchema` is a Zod object
- **WHEN** the tool is constructed
- **THEN** the emitted tool definition has an object input schema accepted by AI SDK

#### Scenario: A union-shaped schema is rejected at construction

- **GIVEN** a `defineTool` call whose `inputSchema` is a `z.discriminatedUnion`
- **WHEN** the tool is constructed
- **THEN** construction throws, identifying that the schema cannot be represented as the required top-level object tool input

#### Scenario: A declared describeCall rides on the packaged tool

- **GIVEN** a `defineTool` call that declares `describeCall`
- **WHEN** the tool is constructed
- **THEN** the packaged `Tool` exposes the hook, and the emitted AI SDK tool definition is unchanged — the hook is never sent to the model

#### Scenario: An omitted describeCall constructs normally

- **GIVEN** a `defineTool` call that declares no `describeCall`
- **WHEN** the tool is constructed
- **THEN** construction succeeds and the packaged `Tool` carries no hook
