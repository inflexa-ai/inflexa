## ADDED Requirements

### Requirement: The planner submits through tools that do not end its run

The planner MUST declare its search tools first and the terminal tools `submit_plan`, `request_clarification`, and `report_blocker` last. `submit_plan` checks a candidate and gives back the accepted plan or the structured issues. A candidate that arrives as a JSON-encoded string MUST be decoded before the check. No terminal tool ends the run, and no terminal tool writes to the database.

#### Scenario: A refused candidate gets its issues

- **WHEN** the planner submits a candidate that fails the check
- **THEN** the call gives back the issues, and the planner can submit again

#### Scenario: A plan that arrives as a JSON-encoded string

- **WHEN** the planner submits a valid plan as a JSON-encoded string
- **THEN** the call decodes it and gives back the accepted plan

#### Scenario: The knowledge tools ride with the search tools

- **GIVEN** a `GeneratePlanDeps` with a knowledge client
- **WHEN** the planner tools are built
- **THEN** the list holds `knowledge_recommend` and `knowledge_check` before the terminal tools

### Requirement: The tool persists the selected plan after the run

After the run, `generate_plan` MUST select the outcome: the last accepted plan, else the last clarification, else the first blocker. It MUST persist an accepted plan once, under an id that a rerun gives again. The host MUST fill the snapshot and the template of each step from the knowledge answer of the run. The model does not copy them.

#### Scenario: A rerun persists no second plan

- **WHEN** the persist of a selected plan runs two times for the same call
- **THEN** the database holds one plan for that call

#### Scenario: The host fills the grounding

- **GIVEN** a run whose `knowledge_recommend` answer named a snapshot and a template
- **WHEN** the plan persists
- **THEN** each grounded step carries that snapshot and that template, whatever the candidate held

### Requirement: The planner run is capped, with one salvage request

The planner run MUST have a step cap that `PLANNER_MAX_ITERATIONS` owns. When the run ends with no outcome, and it was not aborted, one salvage request MUST follow. Only the terminal tools can run in it. When the salvage gives no outcome, the tool returns an `error` event that states that the planner produced no outcome.

#### Scenario: A salvage after the cap

- **WHEN** the planner reaches its cap with no outcome
- **THEN** one salvage request follows, and only `submit_plan`, `request_clarification`, and `report_blocker` can run in it
