## MODIFIED Requirements

### Requirement: The planner separates non-terminal tools from a terminal outcome set

The planner MUST be given the terminal tools `submit_plan`,
`request_clarification`, and `report_blocker`, and non-terminal tools that
include `list_available_refs` (reference-store discovery). `submit_plan`
MUST re-validate and persist the plan, and a rejected candidate MUST return
the structured issues, thus the planner corrects the plan and submits again.
Exactly one terminal outcome MUST be recorded per invocation, and a later
terminal call MUST be rejected. A non-terminal tool records no outcome, and
the planner can call it any number of times.

The planner MUST hold the search tools first and the terminal tools last. The search tools MUST include `knowledge_recommend` and `knowledge_check` when `GeneratePlanDeps.knowledge` is bound, and MUST NOT include them otherwise. A search tool never writes and never computes.

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

#### Scenario: A second terminal call is rejected

- **WHEN** a terminal outcome has already been recorded and `submit_plan` is called again
- **THEN** the call is rejected and the recorded outcome is left unchanged

#### Scenario: The knowledge tools ride with the search tools

- **GIVEN** a `GeneratePlanDeps` with a knowledge client
- **WHEN** the planner tools are built
- **THEN** the list holds the two knowledge tools before the terminal tools

## ADDED Requirements

### Requirement: Each plan step can carry a grounding

The planner output schema MUST accept an optional `grounding` object on each step. The description of the field MUST tell the planner to fill it from the answer of `knowledge_recommend` when that tool is attached, and to omit it otherwise. Phase 0 MUST validate the shape only.

#### Scenario: A grounded plan persists the field

- **GIVEN** a submitted plan whose steps carry a grounding
- **WHEN** the plan is persisted and loaded
- **THEN** each step carries its grounding unchanged
