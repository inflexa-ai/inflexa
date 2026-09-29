## MODIFIED Requirements

### Requirement: The planner separates non-terminal tools from a terminal outcome set

The planner MUST be given the terminal tools `submit_plan`,
`request_clarification`, and `report_blocker`, and non-terminal tools that
include `list_available_refs` (reference-store discovery). `submit_plan`
MUST re-validate and persist the plan, and a rejected candidate MUST return
the structured issues, thus the planner corrects the plan and submits again.
A candidate that arrives as a JSON-encoded string MUST be decoded before the
re-validation. The permissive arg schema accepts the string, thus the
loop-boundary repair never sees it. Exactly one terminal outcome MUST be
recorded per invocation, and a later terminal call MUST be rejected. A
non-terminal tool records no outcome, and the planner can call it any number
of times.

#### Scenario: A rejected submit returns the issues and records no outcome

- **WHEN** the planner submits a candidate plan that fails validation
- **THEN** the call returns `{ accepted: false, issues }` and records no terminal outcome
- **AND** the planner can submit again

#### Scenario: The planner can see what reference data is staged

- **WHEN** the planner calls `list_available_refs`
- **THEN** it receives the current reference inventory and records no outcome
- **AND** the planner can ground the reference needs of a step in that result, or take a terminal `request_clarification` exit when data the analysis cannot continue without is absent

#### Scenario: submit_plan re-validates and persists

- **WHEN** the planner calls `submit_plan` with a plan that passes validation
- **THEN** the plan is persisted and the outcome is recorded as a submitted plan with its `planId`

#### Scenario: A plan that arrives as a JSON-encoded string

- **WHEN** the planner calls `submit_plan` with the plan as a JSON-encoded string of a valid plan
- **THEN** the plan is decoded, persisted, and the outcome is recorded as a submitted plan

#### Scenario: A second terminal call is rejected

- **WHEN** a terminal outcome has already been recorded and `submit_plan` is called again
- **THEN** the call is rejected and the recorded outcome is left unchanged
