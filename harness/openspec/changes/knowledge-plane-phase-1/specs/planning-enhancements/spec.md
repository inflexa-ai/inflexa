# planning-enhancements Specification (delta)

## ADDED Requirements

### Requirement: The plan step schema carries an optional grounding field

`AnalysisStepSchema` MUST gain a `grounding` field: a list of cited rule identifiers, each with an optional note. The field MUST stay optional on the persistence schema, thus a historical plan parses, in the pattern of `resources`. The field description in the schema MUST teach the planner to cite only identifiers that its knowledge context returned.

#### Scenario: A historical plan parses

- **WHEN** a stored plan from before this change loads
- **THEN** the read-side parse succeeds with no `grounding` field

#### Scenario: A planner output carries citations

- **WHEN** the planner submits a plan under a resolved knowledge source
- **THEN** the accepted plan carries the cited rule identifiers on its steps

### Requirement: The planner seed carries a knowledge brief when a source is resolved

Before the loop, the host MUST query the knowledge source with the categorical profile facts. The profiler is never extended for the gate: a numeric fact, such as the smallest group size, comes from the planner through `knowledge_search`, from the design its Data Context states. The seed MUST gain a knowledge-brief block beside the reference and package censuses. The block MUST list each returned rule with its id, its statement, and its severity, `reject` and `applies` first, under a byte cap. Truncation MUST fall on an entry boundary and MUST name the count of the rules it hid. Each returned match MUST be recorded into the invocation citation set and the obligation map. When the source is absent, the block MUST be one line that states the absence.

#### Scenario: Applicable rules ride in the seed

- **WHEN** the profile names bulk RNA-seq with two samples for each group
- **THEN** the brief lists the small-sample DE rule with severity `reject`, before the planner starts

#### Scenario: An absent source stays visible

- **WHEN** no knowledge source is resolved
- **THEN** the seed states that no knowledge source is available, and nothing else changes

### Requirement: Plan validation runs a grounded gate after the structural checks

`fullyValidate` MUST gain a third stage. The stage MUST reject a cited identifier that is outside the invocation citation set. The obligation map is live: the seed-time brief and each later `knowledge_search` result record into it, and an `applies` verdict overrides a `not_evaluable` one for the same id. The stage MUST demand an acknowledgment of each `reject` rule whose recorded verdict is `applies`: a plan that cites the rule nowhere is rejected, with a `ValidationIssue` that carries code `grounding`, the rule id, and the rule statement. The gate enforces the acknowledgment, not method compliance, because a Phase-1 step carries no typed method. A `warn` or `note` outcome MUST return as advisory content, and it MUST NOT block. A `not_evaluable` rule MUST report an advisory note. The stage MUST be inert exactly when no knowledge source is resolved. A failed brief query narrows what is citable, and it MUST NOT turn the stage off.

#### Scenario: An unreturned citation is rejected

- **WHEN** a submitted plan cites a rule id that no brief and no tool call returned
- **THEN** `submit_plan` returns `accepted: false` with a `grounding` issue that names the id

#### Scenario: An unacknowledged reject rule blocks with feedback

- **WHEN** `knowledge_search` returned the small-sample rule as `applies` for one sample in a group, and the plan cites it nowhere
- **THEN** the gate returns the rule as a structured issue with its statement, and the planner can cite it or revise

#### Scenario: No knowledge source, no gate

- **WHEN** no knowledge source is resolved
- **THEN** `fullyValidate` behaves exactly as before this change

### Requirement: An acknowledged rule passes, and its citation persists

When the plan cites each applying `reject` rule, the gate MUST pass, and the persisted plan MUST carry the citations on its steps. The advisory content rides on acceptance and on rejection alike.

#### Scenario: A cited acknowledgment persists into the plan

- **WHEN** the plan cites the applying reject rule in the step it constrains
- **THEN** `submit_plan` accepts, and the stored plan step carries the rule id in its `grounding`
