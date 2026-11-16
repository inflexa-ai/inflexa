## MODIFIED Requirements

### Requirement: The ad hoc input selects the agent of the step

The `agent` of an ad hoc tool input MUST be the id of an enabled executor of the
catalog. The chat agent MUST get the ids and the descriptions of the enabled
executors when its turn starts. When the input has no `agent`, the step MUST run
on `analyst`. The harness MUST make no model call to select the agent. It MUST
record no usage under a router agent id.

#### Scenario: An input with no agent runs on the analyst

- **WHEN** the conversation agent calls ad hoc `execute_analysis` with no `agent`
- **THEN** the internal step names `analyst`

#### Scenario: An input can name the drug analyst

- **WHEN** the conversation agent calls ad hoc `execute_analysis` with `agent = "drug-analyst"` for a question about the exposure of a compound
- **THEN** the internal step names `drug-analyst`

#### Scenario: An input can name a custom executor

- **GIVEN** a catalog with the enabled custom executor `lipid-analyst`
- **WHEN** the conversation agent calls ad hoc `execute_analysis` with `agent = "lipid-analyst"`
- **THEN** the internal step names `lipid-analyst`

#### Scenario: An unknown agent is refused

- **WHEN** the input names an agent that is not an enabled executor
- **THEN** input validation refuses the call before persistence, authorization, or launch
