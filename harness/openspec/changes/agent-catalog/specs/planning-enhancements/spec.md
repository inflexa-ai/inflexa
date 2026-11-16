## MODIFIED Requirements

### Requirement: The agent catalog is injected into the planner prompt

When the planner makes a plan, it MUST read the agent catalog. It MUST render
the id and the description of each enabled executor into the
`{{AGENT_CATALOG}}` placeholder of its prompt. The plan step `agent` field MUST accept only an id
from that list. The planner prompt MUST NOT hold a routing rule that names an
agent, because the user can add and remove executors.

#### Scenario: Planner prompt carries the rendered catalog

- **WHEN** the planner system prompt is assembled
- **THEN** its `{{AGENT_CATALOG}}` placeholder is replaced with the id and the description of each enabled executor

#### Scenario: A custom executor is in the planner catalog

- **GIVEN** a catalog with the enabled custom executor `lipid-analyst`
- **WHEN** the planner makes a plan
- **THEN** the planner catalog lists `lipid-analyst`, and a step can name it

#### Scenario: A plan that names an unknown agent is refused

- **WHEN** the planner gives a step whose `agent` is not an enabled executor
- **THEN** the plan validation refuses the plan and names the step
