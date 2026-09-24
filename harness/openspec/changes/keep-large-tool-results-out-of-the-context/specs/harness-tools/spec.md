## ADDED Requirements

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
