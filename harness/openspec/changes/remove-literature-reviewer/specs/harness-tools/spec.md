# Spec Delta

## MODIFIED Requirements

### Requirement: Each agent with a tool declares read_tool_output

Each agent that the harness assembles with a tool MUST declare `read_tool_output` when its composition has a tool output store. These are the agents:

- the conversation agent
- the report agent
- each sandbox agent and the data profiler, through the substrate
- the planner of `generate_plan`
- the analogical reasoner of `generate_analogy_report`
- the run synthesizer

The agent MUST declare the tool from its first request, thus the tool set of each conversation stays fixed. The loop of an agent MUST keep each text where the tool of that agent reads it. Thus each reference of an excerpt names a record that the agent can read.

A composition with no store MUST NOT declare the tool. The loop of such an agent keeps no text (refer to the harness-agent-loop capability).

#### Scenario: The conversation agent declares the read tool

- **WHEN** the assembled conversation agent lists its tools
- **THEN** `read_tool_output` is present

#### Scenario: A sub-agent reads a kept text of its own loop

- **GIVEN** an analogical reasoner whose search gives a result of 60,000 characters
- **WHEN** the reasoner calls `read_tool_output` with the reference of its excerpt
- **THEN** the call gives a page of the kept text

#### Scenario: A sandbox agent with no store has no read tool

- **GIVEN** a sandbox agent that `createSandboxAgent` builds with no store
- **WHEN** its tools are listed
- **THEN** `read_tool_output` is absent
