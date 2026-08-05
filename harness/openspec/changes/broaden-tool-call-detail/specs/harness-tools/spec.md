## MODIFIED Requirements

### Requirement: Tools are defined through a dependency-agnostic primitive

`defineTool({ id, description, inputSchema, execute, executionMode, describeCall })` SHALL package a `Tool` and emit an AI SDK-compatible tool definition from the Zod `inputSchema`. `defineTool` SHALL NOT take or carry dependencies. A tool that needs dependencies SHALL be a factory closure that captures them and calls `defineTool`.

`describeCall` is REQUIRED, and SHALL be either a synchronous, pure `(input: z.infer<Schema>) => string` that names what this call is doing, or the literal `"none"` declaring that the tool's input cannot distinguish its calls. A definition supplying neither SHALL fail to typecheck. It is the call-time counterpart of `description`: `description` self-describes the tool at attach time, and `describeCall` self-describes one invocation.

The requirement is on the definition, not on the packaged tool. `defineTool` SHALL package the hook only when a function was supplied, so `Tool.describeCall` remains an OPTIONAL function and `"none"` SHALL NOT appear on any packaged tool (see the tool-call-detail capability). Consumers of a packaged tool are therefore unaffected by this requirement.

Requiring the decision rather than defaulting it is deliberate. A positional default drawn from the schema would produce a sensible line for one tool and a content payload for the next, because only the author knows which field identifies a call. Leaving it optional instead lets every tool added after this point ship undescribed by omission, which is how the roster decays.

#### Scenario: A flat-object schema emits a valid AI SDK input schema

- **GIVEN** a `defineTool` call whose `inputSchema` is a Zod object
- **WHEN** the tool is constructed
- **THEN** the emitted tool definition has an object input schema accepted by AI SDK

#### Scenario: A union-shaped schema is rejected at construction

- **GIVEN** a `defineTool` call whose `inputSchema` is a `z.discriminatedUnion`
- **WHEN** the tool is constructed
- **THEN** construction throws, identifying that the schema cannot be represented as the required top-level object tool input

#### Scenario: A declared describeCall rides on the packaged tool

- **GIVEN** a `defineTool` call that declares a `describeCall` function
- **WHEN** the tool is constructed
- **THEN** the packaged `Tool` exposes the hook, and the emitted AI SDK tool definition is unchanged — the hook is never sent to the model

#### Scenario: A declined describeCall constructs without packaging a hook

- **GIVEN** a `defineTool` call that declares `describeCall: "none"`
- **WHEN** the tool is constructed
- **THEN** construction succeeds, the packaged `Tool` carries no `describeCall` property, and the sentinel appears nowhere on it

#### Scenario: An omitted describeCall fails to typecheck

- **GIVEN** a `defineTool` call that declares no `describeCall` at all
- **WHEN** the package is typechecked
- **THEN** compilation fails at that definition
