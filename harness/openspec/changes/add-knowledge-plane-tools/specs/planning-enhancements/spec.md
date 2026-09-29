## MODIFIED Requirements

### Requirement: The planner separates non-terminal tools from a terminal outcome set

The planner MUST hold the search tools first and the terminal tools last. The search tools MUST include `knowledge_recommend` and `knowledge_check` when `GeneratePlanDeps.knowledge` is bound, and MUST NOT include them otherwise. A search tool never writes and never computes.

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
