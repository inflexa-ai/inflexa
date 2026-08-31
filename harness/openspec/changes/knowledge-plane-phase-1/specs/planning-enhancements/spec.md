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

`fullyValidate` MUST gain a third stage with two arms of different force.

**Citation honesty MUST block.** The stage MUST reject a cited identifier that is outside the invocation citation set, with a `ValidationIssue` that carries code `grounding`. This is the ONLY grounding fault that can make a plan invalid. The test is mechanical, it needs no knowledge of the data, and it has no false positive.

**Rule acknowledgment MUST advise, and it MUST NOT block.** Every applicable rule that the plan cites nowhere, and every rule a missing fact left `not_evaluable`, MUST return as advisory content at every severity. A Phase-1 step carries no typed method, thus the gate cannot tell whether a step obeys a rule. A block on the citation alone would punish an honest plan for a missing formality. It would also rest on a fact supply that Phase 1 does not build.

The verdict map is live and LATEST-WINS: the seed-time brief and each later `knowledge_search` result record into it, and a later verdict replaces an earlier one for the same id. A map that only escalated could never withdraw a verdict, because a rule that stops applying is dropped before it is returned.

The stage MUST be inert exactly when no knowledge source is resolved. A failed brief query narrows what is citable, and it MUST NOT turn the stage off.

#### Scenario: An unreturned citation is rejected

- **WHEN** a submitted plan cites a rule id that no brief and no tool call returned
- **THEN** `submit_plan` returns `accepted: false` with a `grounding` issue that names the id

#### Scenario: An uncited applicable rule advises and never blocks

- **WHEN** an applicable `reject`-severity rule is cited nowhere in the plan
- **THEN** `submit_plan` accepts the plan, and the rule rides back as an advisory with its statement

#### Scenario: A corrected fact withdraws an earlier verdict

- **WHEN** the planner probes `knowledge_search` with a wrong group size and then repeats the call with the right one
- **THEN** the later verdict replaces the earlier one, and no advisory reports the withdrawn verdict

#### Scenario: No knowledge source, no gate

- **WHEN** no knowledge source is resolved
- **THEN** `fullyValidate` behaves exactly as before this change

### Requirement: The advisories are ranked, complete, and delivered

The advisories MUST rank `reject` first, then `warn`, then `note`, and an `applies` entry before a `not_evaluable` one. The cap on advisories MUST count the entries below `reject` severity only, thus a `reject` advisory can never be crowded out. The advisories MUST ride on the accepted outcome as well as on a rejection, because the planner never reads an accepted `submit_plan` result.

#### Scenario: A reject advisory survives a flood of softer ones

- **WHEN** thirty applicable `note` rules and one `reject` rule are uncited
- **THEN** the `reject` advisory is present and ranked first, and the softer entries are capped

#### Scenario: The advisories reach the caller of an accepted plan

- **WHEN** `submit_plan` accepts a plan that leaves applicable rules uncited
- **THEN** the tool outcome carries those advisories, and the accept log records their rule identifiers

### Requirement: A stored citation carries its corpus identity

At persist time the host MUST stamp the corpus identity and version onto every citation. It MUST overwrite any value that reached it. A rule id alone stops resolving once the corpus moves on. A stored plan would then name a rule whose text no longer matches what the planner read.

#### Scenario: A persisted citation resolves later

- **WHEN** a plan with citations is persisted under a resolved knowledge source
- **THEN** each stored `grounding` entry carries the corpus id and version, and the model never authored them

### Requirement: Plan iteration preserves the citations

The prior-plan block MUST render each step's cited rule identifiers. Iteration rewrites the steps it keeps, thus a renderer that dropped the citations would make the planner rebuild an unchanged step with no grounding.

#### Scenario: An iterated plan keeps its chain

- **WHEN** the planner iterates a grounded plan with `parentPlanId` set
- **THEN** the prior-plan block names the cited rule ids for each step
