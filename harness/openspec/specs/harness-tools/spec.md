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

**Each tool owns its durability through a declared execution mode.** Each tool
declares or defaults to `executionMode: "step" | "inline"`. A `step` tool runs
through a deterministic durable step wrapper, which caches the whole call. On a
replay, an external lookup tool gives the cached result, and the rate-limited
call does not occur again.
`inline` is reserved for logic whose effects are not durable work. The mode is
the declaration of the tool, not a policy of the loop.

**A tool gives its effect on process state as a call record.**
`execute_command`, `write_file`, and `edit_file` are `step` tools, and the
sandbox exec of `execute_command` runs inside the step of its call. A replay
gives the cached result, and it does not run the body. Thus a tool attaches each
effect on process-local state to its ok value as a call record. The loop folds
each record after the round, on the first run and on each replay. `ToolContext`
carries no durability seam.

## Requirements

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

A tool's `execute` MUST return `Promise<Result<Output, ToolError>>`. Expected outcomes — including "not found", "empty", and "ambiguous" — MUST be `ok` data variants of `Output`, never an error. An unexpected failure (network, upstream 5xx, timeout, a retryable status that outlived the retries) MUST be an `err(ToolError)` or a throw. The loop maps both to one `tool_result { is_error: true }`. The `ok` `Output` MUST NOT carry a `success` boolean or an `error` field.

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

#### Scenario: A throttle that outlives the retries is not an absence

- **GIVEN** a bio-API tool that fetches through `apiFetch`, and an upstream that answers 429 on every attempt
- **WHEN** `execute` runs
- **THEN** the fetch resolves to the unexpected `exhausted` `ApiError`, and the tool surfaces it as an error rather than as a "not found" data variant

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

### Requirement: The shared HTTP helper names the harness

`apiFetch` MUST send the User-Agent `inflexa-harness (+https://inflexa.ai)` on
each request. A User-Agent in the `headers` option of the caller MUST win, in
any letter case. A provider can refuse the default value of the runtime, for
example `node` or `Bun/<version>`.

#### Scenario: A request with no User-Agent from the caller names the harness

- **GIVEN** a bio-API tool that fetches through `apiFetch` with no User-Agent in `headers`
- **WHEN** the request goes out
- **THEN** it carries `User-Agent: inflexa-harness (+https://inflexa.ai)`, and each other header of the caller stays

#### Scenario: The User-Agent of the caller wins

- **GIVEN** a caller that sets `user-agent` in `headers`
- **WHEN** the request goes out
- **THEN** it carries that value only

### Requirement: read_tool_output reads the kept text of a cut tool result

The harness MUST give a tool `read_tool_output`, made by the factory `createReadToolOutputTool(store)`. The factory captures the tool output store, thus `ToolContext` carries no store and no pool. The tool MUST run in the `step` execution mode.

The input MUST be one object with these fields:

- `ref`: the reference that an excerpt gives
- `offset`: the index of the first character of the window, from 0, with the default 0
- `limit`: the count of characters of the window, at most 16,384
- `pattern`: an optional JavaScript regular expression

A character is a UTF-16 code unit of the kept text, the unit of the lengths in an excerpt (refer to the harness-agent-loop capability).

The tool MUST read the record of `ref` in the analysis of `ctx.session.scope`. A reference of a different analysis MUST give the `not_found` data variant. Thus a reference in a tool result or in a prompt cannot reach a different analysis.

Without a pattern, the tool MUST give the characters of the window, with a default limit of 8,192. With a pattern, the tool MUST search the window. When the call gives no limit, the window reaches the end of the kept text.

A search MUST give at most 20 matches, in order. Each match MUST give its offset and a text: up to 150 characters before the match and up to 250 characters from its start. A match of zero length MUST move the search on by one character.

A page and a search MUST give `end`, the offset where the tool stopped. They MUST also give `more`, which is true when the next call can continue at `end`.

The JSON text of each result MUST have at most 32,768 characters minus 512. When a result is longer, the tool MUST shorten the text or drop the last matches, and `end` gives the true stop. Thus the loop never cuts a result of `read_tool_output`.

The expected outcomes MUST be data variants. An unknown reference gives `not_found`. An offset at or past the end of the kept text gives `out_of_range`. A pattern that does not compile gives `invalid_pattern`. A read of the store that fails MUST become an error result.

#### Scenario: A page of the kept text

- **GIVEN** a kept text of 100,000 characters, with no character that JSON escapes
- **WHEN** the model calls `read_tool_output` with its reference, the offset 4,096, and the limit 8,192
- **THEN** the result gives the characters from 4,096 to 12,288, the end 12,288, and the kept length 100,000

#### Scenario: A pattern finds the error

- **GIVEN** a kept text that holds the word `Traceback` one time, at the offset 70,000
- **WHEN** the model calls `read_tool_output` with its reference and the pattern `Traceback`
- **THEN** the result gives one match at the offset 70,000, with the text before and after it

#### Scenario: A reference of a different analysis is not found

- **GIVEN** a kept text of analysis A
- **WHEN** an agent of analysis B calls `read_tool_output` with its reference
- **THEN** the result is the `not_found` data variant, and no text of analysis A reaches the model

#### Scenario: A page of escaped text stays under the cap

- **GIVEN** a kept text in which each character is a quote
- **WHEN** the model reads 16,384 characters of it
- **THEN** the JSON text of the result has at most 32,256 characters
- **AND** `end` is less than 16,384, and `more` is true

#### Scenario: An invalid pattern is data

- **WHEN** the model calls `read_tool_output` with the pattern `(`
- **THEN** the result is the `invalid_pattern` data variant, and the call is not an error

### Requirement: Each agent with a tool declares read_tool_output

Each agent that the harness assembles with a tool MUST declare `read_tool_output` when its composition has a tool output store. These are the agents:

- the conversation agent
- the report agent
- each sandbox agent and the data profiler, through the substrate
- the planner of `generate_plan`
- the analogical reasoner of `generate_analogy_report`
- the literature reviewer
- the run synthesizer

The agent MUST declare the tool from its first request, thus the tool set of each conversation stays fixed. The loop of an agent MUST keep each text where the tool of that agent reads it. Thus each reference of an excerpt names a record that the agent can read.

A composition with no store MUST NOT declare the tool. The loop of such an agent keeps no text (refer to the harness-agent-loop capability).

#### Scenario: The conversation agent declares the read tool

- **WHEN** the assembled conversation agent lists its tools
- **THEN** `read_tool_output` is present

#### Scenario: A sub-agent reads a kept text of its own loop

- **GIVEN** a literature reviewer whose search gives a result of 60,000 characters
- **WHEN** the reviewer calls `read_tool_output` with the reference of its excerpt
- **THEN** the call gives a page of the kept text

#### Scenario: A sandbox agent with no store has no read tool

- **GIVEN** a sandbox agent that `createSandboxAgent` builds with no store
- **WHEN** its tools are listed
- **THEN** `read_tool_output` is absent

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
