## ADDED Requirements

### Requirement: A step seed carries a frozen read-only copy of the goal and the constraints

The seed of each sandbox step MUST carry a copy of the goal and the constraints of the working memory of its analysis. Each constraint MUST show its origin, `user` or `agent`. The copy MUST NOT hold a hypothesis, a finding, or an entry id.

The harness MUST read working memory at the dispatch of each step, inside the checkpointed step that composes the seed. It MUST NOT read it one time for each run. Thus a memory edit during a run reaches each step that the scheduler dispatches after the edit. Two steps of one run can thus carry different memory states. A replay of the seed step MUST give the recorded seed, and it MUST NOT read working memory again.

The copy is read only. The step agent gets no tool that reads or writes working memory.

The copy MUST show under the heading `## Analysis memory (read only)`. This heading is different from the heading of the constraints of the plan step. The section MUST tell the agent that the entries come from the working memory of the analysis. It MUST tell the agent to obey a constraint from the user, and to use a constraint from the agent as context.

The section MUST obey `WORKING_MEMORY_LIMITS`. It clamps the goal and each constraint text, and it shows only the newest constraints up to the cap. A memory with no goal and no constraints MUST give no section.

If the memory read fails, the seed step MUST compose the seed without the section, and it MUST log a warning that names the analysis and the step. A failed memory read MUST NOT stop the dispatch of the step.

#### Scenario: A step seed shows the goal and the constraints with their origin

- **GIVEN** an analysis whose working memory holds a goal, a constraint from the user, a constraint from the agent, a hypothesis, and a finding
- **WHEN** the parent workflow dispatches a step of that analysis
- **THEN** the seed holds the section `## Analysis memory (read only)` with the goal and the two constraints
- **AND** each constraint shows its origin
- **AND** the seed holds no hypothesis and no finding

#### Scenario: An empty memory gives no section

- **GIVEN** an analysis with no working-memory row
- **WHEN** the parent workflow dispatches a step of that analysis
- **THEN** the seed holds no analysis-memory section

#### Scenario: A later step sees an edit made during the run

- **GIVEN** a run whose first step started with the constraint `A`
- **AND** the conversation agent then replaces `A` with the constraint `B`
- **WHEN** the parent workflow dispatches a second step of the same run
- **THEN** the seed of the second step holds `B` and not `A`
- **AND** the seed of the first step stays as DBOS recorded it

#### Scenario: A replay gives the recorded seed

- **GIVEN** a seed step that DBOS recorded
- **WHEN** DBOS replays the parent workflow
- **THEN** the step gets the recorded seed, byte for byte
- **AND** the harness does not read working memory for that step

#### Scenario: A failed memory read leaves the section out

- **GIVEN** a working-memory read that gives a database error
- **WHEN** the parent workflow composes the seed of a step
- **THEN** the seed has no memory section, and the step is dispatched
- **AND** the log records a warning that names the analysis and the step
