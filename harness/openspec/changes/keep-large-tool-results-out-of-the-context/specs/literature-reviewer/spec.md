## MODIFIED Requirements

### Requirement: Bio-lookup tool surface

The literature reviewer agent MUST have a focused bio-lookup tool surface and `read_tool_output`. It MUST have no workspace tools, no sandbox tools, and no memory tools. `read_tool_output` reads the kept text of a lookup result that the loop cut (refer to the harness-tools capability). It is not a workspace tool, because it reads the tool output store and no file.

#### Scenario: Tool inventory

- **WHEN** a reader inspects the agent definition of the literature reviewer
- **THEN** its `tools` array contains exactly the bio-lookup tools of the local `reviewerTools` const, and then `read_tool_output`

#### Scenario: No workspace or memory tools

- **WHEN** a reader inspects the agent definition of the literature reviewer
- **THEN** the tool list contains no workspace tools (`read_file`, `grep`, `workspace_search`)
- **AND** no memory tools (`updateWorkingMemory`)

#### Scenario: The reviewer reads the rest of a long lookup

- **GIVEN** a reviewer whose PubMed search gives a result of 60,000 characters
- **WHEN** the reviewer calls `read_tool_output` with the reference of the excerpt
- **THEN** the call gives a page of the kept text

### Requirement: Run synthesis is the agentic run-synthesizer loop

Run synthesis MUST run as the agentic `run-synthesizer` loop (`generateRunSynthesis` in `harness/src/execution/run-synthesis.ts`). `runToTerminal` drives the loop over `passthroughStep`, with the system prompt `synthesis-agent.ts`, the agent id `run-synthesizer`, and `maxIterations` 25.

Its tool surface MUST be exactly `validate_synthesis`, `submit_synthesis`, `report_blocker`, the embedded `literature_reviewer` sub-agent tool, and `read_tool_output`. The synthesizer and the embedded reviewer MUST use the tool output store of the run.

The host-agnostic `synthesizeRun` service (`harness/src/app/synthesize-run.ts`) MUST load the step summaries of the run. It MUST build the prompt from the step summaries and the analytical narrative of the plan. It MUST drive the loop under a `forSubAgent(session, "run-synthesizer")` session. On success it MUST index the synthesis vector, persist `synthesis.json`, and emit a `data-run-synthesis` chat part.

#### Scenario: Synthesizer reaches the user only through a terminal tool

- **WHEN** the run-synthesizer loop runs
- **THEN** the only way a synthesis or a blocker reaches the caller is a `submit_synthesis` or `report_blocker` call
- **AND** the agent does its research through briefs to the `literature_reviewer` tool

#### Scenario: Deliverables of a successful synthesis

- **WHEN** the synthesizer calls `submit_synthesis` with a payload that passes validation
- **THEN** `synthesizeRun` persists `synthesis.json` to the run directory and emits a `data-run-synthesis` chat part

#### Scenario: The synthesizer reads a long report again

- **GIVEN** a reviewer report of 40,000 characters that the loop of the synthesizer cut
- **WHEN** the synthesizer calls `read_tool_output` with the reference of the excerpt
- **THEN** the call gives a page of the report
