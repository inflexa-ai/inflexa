# Delta: planning-enhancements

No text of this change names a `validate_plan` tool. The commit `ae57869d`
(2026-07-30) removed that planner tool and folded its dry-run into
`submit_plan`, and the spec never followed. This delta corrects the drift:
the validation surface is the shared plan validation, called by the
`submit_plan` re-validation and by the pre-launch re-validation.

## ADDED Requirements

### Requirement: The plan validation enforces the per-step resource ceiling

The shared plan validation MUST, when a resource policy is supplied, report
an issue for every step whose declared `resources` exceed `perStep.maxCpu`
or `perStep.maxMemoryGb`. The issue MUST name the step, its declared values,
and the ceiling, thus the planner can resize or restructure. The check is
deterministic validation feedback, not a terminal outcome — the run-time
clamp at sandbox creation stays the backstop for plans that predate this
validation.

#### Scenario: An over-ceiling step is reported with actionable feedback

- **GIVEN** a per-step ceiling of `{ maxCpu: 4, maxMemoryGb: 8 }` and a candidate plan step that declares `{ cpu: 4, memoryGb: 16 }`
- **WHEN** the planner submits the plan
- **THEN** the submit is rejected with an issue that names the step, the declared 16 GB, and the 8 GB ceiling

#### Scenario: A plan within the ceiling passes

- **GIVEN** every step declares resources at or under the per-step ceiling
- **WHEN** the plan validates
- **THEN** no resource-ceiling issue is reported

### Requirement: Each plan step names its packages

In `PlanStepSchema`, the `packages` array MUST be a necessary field of every
planned step. Each entry MUST be a requirement: a bare name, or a name with
one exact version.
The persistence schema MUST keep the field optional, thus a stored plan from
before this change still parses. The briefing MUST withhold the `packages`
field from the rendered task, because the link pass consumes it and a step
agent must not re-litigate it.

#### Scenario: A new plan carries packages on every step

- **WHEN** the planner submits a plan
- **THEN** every step holds a `packages` array, possibly empty

#### Scenario: An old stored plan still parses

- **GIVEN** a persisted plan whose steps have no `packages` field
- **WHEN** the plan loads
- **THEN** the load succeeds

#### Scenario: The briefing withholds the field

- **GIVEN** a step with a non-empty `packages` array
- **WHEN** the briefing renders the task
- **THEN** the rendered text does not name the array

### Requirement: The plan validation refuses a package location

The shared plan validation MUST report an issue for every package entry that
names a path, a URL, or a store directory. The two callers of the validation
are the re-validation of `submit_plan` and the pre-launch re-validation of a
stored plan. The issue MUST name the step and the offending entry. An absent
`packages` array MUST pass, because the stored plans from before this change
carry none.

#### Scenario: A path is refused

- **GIVEN** a candidate plan step whose packages include `/mnt/libs/store/scanpy-1.12.3-e71bae79`
- **WHEN** the planner submits the plan
- **THEN** the submit is rejected, with an issue that names the step and the entry

#### Scenario: A requirement form passes

- **GIVEN** a step whose packages are `["scanpy", "numpy==1.26.4"]`
- **WHEN** the plan validates
- **THEN** no package-form issue is reported

### Requirement: The planner prompt teaches the package field

The planner system prompt MUST carry a section on the packages of each step.
It MUST instruct: name each package as a requirement, never a path or a URL.
It MUST state that the set is not a promise of completeness, because the
execution agent can still link a missing package. The matched anti-pattern
list MUST gain the location form.

#### Scenario: The prompt names the requirement form

- **WHEN** the planner system prompt is assembled
- **THEN** it instructs the planner to name each package as a requirement and never as a location

### Requirement: A plan's packages link before the launch

When the farm-extension seam is bound, the launch MUST link the plan's
packages before the run reserves anything. The linked set is the union of
the packages of each step, and it goes into the farm of the analysis. A
pool miss MUST refuse the launch with an error that
names the missing packages. The harness MUST NOT name a remedy command,
because the remedy belongs to the embedder. Without a bound seam, the pass
MUST return at once.

#### Scenario: The link pass runs before the run

- **GIVEN** a bound seam and a plan whose packages the pool holds
- **WHEN** the launch runs
- **THEN** every named package links into the farm before the first sandbox action

#### Scenario: A pool miss refuses the launch

- **GIVEN** a plan that names a package the pool does not hold
- **WHEN** the launch runs
- **THEN** the launch refuses with the missing names, and no run starts

#### Scenario: No seam means no pass

- **GIVEN** no bound farm-extension seam
- **WHEN** the launch runs
- **THEN** the link pass returns at once, and the launch continues

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

#### Scenario: A rejected submit returns the issues and records no outcome

- **WHEN** the planner submits a candidate plan that fails validation
- **THEN** the call returns `{ accepted: false, issues }` and records no terminal outcome
- **AND** the planner can submit again

#### Scenario: The planner can see what reference data is staged

- **WHEN** the planner calls `list_available_refs`
- **THEN** it receives the current reference inventory and records no outcome
- **AND** the planner can ground the reference needs of a step in that result, or take a terminal `request_clarification` exit when data the analysis cannot continue without is absent

## REMOVED Requirements

### Requirement: validate_plan enforces the per-step resource ceiling

**Reason**: The `validate_plan` tool left the code in the commit `ae57869d`
(2026-07-30), and its dry-run folded into the `submit_plan` re-validation.
The ceiling check itself stays, under "The plan validation enforces the
per-step resource ceiling".
**Migration**: None. The shared plan validation runs the same check on every
path.
