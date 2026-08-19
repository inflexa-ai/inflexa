# Delta: planning-enhancements

## ADDED Requirements

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

### Requirement: validate_plan refuses a package location

`validate_plan`, and the re-validation of `submit_plan`, MUST report an issue
for every package entry that names a path, a URL, or a store directory. The
issue MUST name the step and the offending entry. An absent `packages` array
MUST pass, because the stored plans from before this change carry none.

#### Scenario: A path is refused

- **GIVEN** a candidate plan step whose packages include `/mnt/libs/store/scanpy-1.12.3-e71bae79`
- **WHEN** the planner calls `validate_plan`
- **THEN** the result is invalid, with an issue that names the step and the entry

#### Scenario: A requirement form passes

- **GIVEN** a step whose packages are `["scanpy", "numpy==1.26.4"]`
- **WHEN** the planner calls `validate_plan`
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
