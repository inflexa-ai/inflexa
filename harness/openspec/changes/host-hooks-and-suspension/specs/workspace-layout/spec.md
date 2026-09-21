## ADDED Requirements

### Requirement: A step id is a valid label value

The plan validator (`src/schemas/validate-plan.ts`) MUST accept a step id only if it is a safe
id and a valid label value. A valid label value has 1 to 63 characters, and it holds only
letters, digits, `.`, `_`, and `-`. Its first character and its last character MUST each be a
letter or a digit. If a step id does not obey this rule, the validator MUST refuse the plan.
The message MUST give the rule, thus the planner can make the plan again.

The safe-id rule (`SAFE_ID` in `src/workspace/paths.ts`) has no length limit. It also lets `_`,
`.`, and `-` start or end an id. But the step id becomes the value of the sandbox label
`cortex/step-id`, and the harness does not change a label value (see the sandbox-labels spec).
Thus the validator refuses a bad step id at plan time, before the K8s API server can refuse the
spawn of the step.

The rule applies to a step id only. Each other safe id, for example a report id or a thread id,
keeps the safe-id rule alone. Each literal step id of the harness (`synthesis`, `profile`,
`derive`, and `extract`) obeys the rule too.

#### Scenario: A step id longer than 63 characters is refused

- **GIVEN** a plan with a step id of 64 letters
- **WHEN** the plan validator runs
- **THEN** the validator refuses the plan
- **AND** the message gives the rule of a valid label value

#### Scenario: A safe id with a separator at one end is refused as a step id

- **GIVEN** a plan with the step id `_qc`, which is a safe id
- **WHEN** the plan validator runs
- **THEN** the validator refuses the plan, because `_qc` starts with `_`

#### Scenario: A step id at the limit is accepted

- **GIVEN** a plan with a step id of 63 characters that starts and ends with a letter, and that holds `.`, `_`, and `-` between them
- **WHEN** the plan validator runs
- **THEN** the validator accepts the step id

#### Scenario: A different safe id keeps the safe-id rule

- **GIVEN** a report id of 80 letters
- **WHEN** `reportDir` composes the path for that id
- **THEN** the path builder accepts the id, because the label rule applies to a step id only

#### Scenario: The literal step ids obey the rule

- **WHEN** the harness uses `synthesis`, `profile`, `derive`, or `extract` as a step id
- **THEN** that id is a valid label value
