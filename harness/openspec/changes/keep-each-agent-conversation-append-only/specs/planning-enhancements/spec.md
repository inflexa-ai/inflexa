## MODIFIED Requirements

### Requirement: The planner loop is iteration-capped with one salvage continuation

The planner loop MUST have a cap of `PLANNER_MAX_ITERATIONS = 13`. When the planner ends without a terminal outcome, `runToTerminal` MUST run exactly one salvage continuation, opened by a corrective nudge. The salvage continuation MUST keep the declared tools of the planner, and its mask MUST let only the terminal tools run (refer to the harness-agent-loop capability).

#### Scenario: Salvage continuation on a missing terminal outcome

- **WHEN** the planner reaches its iteration cap without a terminal outcome
- **THEN** `runToTerminal` runs one salvage continuation whose mask lets only `submit_plan`, `request_clarification`, and `report_blocker` run
- **AND** each request of the salvage declares the search tools and the terminal tools of the planner

#### Scenario: Still no outcome after salvage

- **WHEN** the salvage continuation also ends without a terminal outcome
- **THEN** the tool returns an `error` event that states that the planner produced no terminal outcome
