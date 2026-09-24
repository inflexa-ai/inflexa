## MODIFIED Requirements

### Requirement: The step seed carries the concrete paths, not the system prompt

The seed of a step is its sole initial user message. `composeStepBriefing` (`harness/src/prompts/briefing.ts`) MUST compose it from these parts:

- the instruction fields of the plan step: `name`, `question`, `description`, `context`, `constraints`, `acceptance_criteria`, and `caveats`. The seed skips each empty field.
- a Workspace section from `renderWorkspace`, which names the two in-sandbox paths as they are.
- a read-only copy of the goal and the constraints of the working memory of the analysis, under its own heading (see the harness-working-memory capability).

Each value for one step MUST be in the seed and MUST NOT be in the system prompt. These values are the paths, the data orientation, the copy of the analysis memory, and the result of each completed dependency. Thus the composed `systemPrompt` stays a pure function of the agent type. The prompt cache of the provider can then use its prefix again for each step of each run.

#### Scenario: The seed names both paths

- **WHEN** `composeStepBriefing` composes the seed of a dispatched step
- **THEN** its Workspace section names the writable working directory (the cwd of the agent) and the read-only analysis root
- **AND** the task sections hold only the instruction fields of the step that have a value

#### Scenario: The seed carries the analysis memory

- **GIVEN** an analysis whose working memory holds a goal or a constraint
- **WHEN** `composeStepBriefing` composes the seed of a dispatched step
- **THEN** the seed holds the section `## Analysis memory (read only)`
- **AND** the system prompt holds no text of that memory

#### Scenario: The system prompt is byte-identical across steps

- **GIVEN** two different steps of the same run with the same sandbox agent type
- **WHEN** the harness compares their `AgentDefinition.systemPrompt` strings
- **THEN** the strings MUST be byte-identical, with no path, no id, and no placeholder that has no value
