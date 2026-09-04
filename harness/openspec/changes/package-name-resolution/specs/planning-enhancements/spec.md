## MODIFIED Requirements

### Requirement: Each plan step names its packages

In `PlanStepSchema`, the `packages` array MUST be a necessary field of every
planned step. Each entry MUST be a requirement: a bare name, or a name with
one exact version. An entry can carry an ecosystem prefix before the name,
`python:` or `r:`. The prefix names the track of the pool that the link
pass searches. A bare name searches both tracks. The persistence schema
MUST keep the field optional, thus a stored plan from before this change
still parses. The briefing MUST withhold the `packages` field from the
rendered task, because the link pass consumes it and a step agent must not
re-litigate it.

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

#### Scenario: A prefixed entry parses into a qualified request

- **GIVEN** a step whose packages are `["python:igraph", "r:decoupleR", "scanpy", "numpy==1.26.4"]`
- **WHEN** the link pass parses the entries
- **THEN** the requests carry the ecosystems `python`, `r`, none, and none, with the names `igraph`, `decoupleR`, `scanpy`, and `numpy`

### Requirement: The plan validation refuses a package location

The shared plan validation MUST report an issue for every package entry that
names a path, a URL, or a store directory. The two callers of the validation
are the re-validation of `submit_plan` and the pre-launch re-validation of a
stored plan. The issue MUST name the step and the offending entry. An absent
`packages` array MUST pass, because the stored plans from before this change
carry none.

The validation MUST also refuse a version specifier that is not `==`. The
two permitted forms are a bare name and `name==version`. A range such as
`numpy>=1.26` otherwise becomes a package NAME, and the link pass then
refuses a package that the pool holds.

The validation MUST also refuse a prefix that is not `python:` or `r:`. An
entry such as `bioc:fgsea` otherwise becomes a package NAME, and the pool
refuses a package that it holds. The issue MUST name the two permitted
prefixes.

#### Scenario: A path is refused

- **GIVEN** a candidate plan step whose packages include `/mnt/libs/store/scanpy-1.12.3-e71bae79`
- **WHEN** the planner submits the plan
- **THEN** the submit is rejected, with an issue that names the step and the entry

#### Scenario: A requirement form passes

- **GIVEN** a step whose packages are `["scanpy", "numpy==1.26.4"]`
- **WHEN** the plan validates
- **THEN** no package-form issue is reported

#### Scenario: A range specifier is refused

- **GIVEN** a step whose packages include `numpy>=1.26`
- **WHEN** the plan validates
- **THEN** an issue names the step and the entry, and it names the two permitted forms

#### Scenario: A prefixed form passes

- **GIVEN** a step whose packages are `["python:igraph", "r:decoupleR==2.17.0"]`
- **WHEN** the plan validates
- **THEN** no package-form issue is reported

#### Scenario: An unknown prefix is refused

- **GIVEN** a step whose packages include `bioc:fgsea`
- **WHEN** the plan validates
- **THEN** an issue names the step and the entry, and it names `python:` and `r:` as the permitted prefixes

### Requirement: The planner prompt teaches the package field

The planner system prompt MUST carry a section on the packages of each step.
It MUST instruct: name each package as a requirement, never a path or a URL.
It MUST state that the set is not a promise of completeness, because the
execution agent can still link a missing package. It MUST instruct: when
the census shows a name under the Python section and under the R section,
write the prefixed form that the census shows. It MUST state that a bare
both-track name refuses the launch. The matched anti-pattern list MUST gain
the location form.

#### Scenario: The prompt names the requirement form

- **WHEN** the planner system prompt is assembled
- **THEN** it instructs the planner to name each package as a requirement and never as a location

#### Scenario: The prompt names the prefix

- **WHEN** the planner system prompt is assembled
- **THEN** it instructs the planner to write `python:<name>` or `r:<name>` for a name that both sections show

### Requirement: A plan's packages link before the launch

When the farm-extension seam is bound, the launch MUST link the plan's
packages before the run reserves anything. The linked set is the union of
the packages of each step, and it goes into the farm of the analysis. The
union keys entries by their exact spelling, because two spellings are two
identities: `decoupler` and `decoupleR` name two packages. A prefixed
entry and a bare entry of one spelling make one request, and the request
carries the prefix. Two entries of one spelling with two prefixes make two
requests, because the plan names two packages.
The pass MUST pass the ecosystem of a prefixed entry to the seam.

A pool miss MUST refuse the launch with an error that names the missing
packages. A `collision` outcome MUST refuse the launch with an error that
names the two store directories and the two prefixed forms to write. The
harness MUST NOT name a remedy command, because the remedy belongs to the
embedder. The prefix is a plan form and not a command, thus the refusal
names it. Without a bound seam, the pass MUST return at once.

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

#### Scenario: A prefixed entry reaches the seam with its ecosystem

- **GIVEN** a plan whose steps name `python:igraph` and `r:igraph`
- **WHEN** the link pass runs
- **THEN** the seam receives two requests for `igraph`, one with `ecosystem: "python"` and one with `ecosystem: "r"`

#### Scenario: A prefixed entry absorbs a bare entry of the same name

- **GIVEN** a plan whose steps name `python:igraph` and `igraph`
- **WHEN** the link pass runs
- **THEN** the seam receives one request for `igraph`, with `ecosystem: "python"`

#### Scenario: Two spellings of one fold make two requests

- **GIVEN** a plan whose steps name `decoupler` and `decoupleR`, both bare
- **WHEN** the link pass runs
- **THEN** the seam receives two requests, `decoupler` and `decoupleR`, each with no ecosystem

#### Scenario: A collision refusal names the prefixed forms

- **GIVEN** a plan that names `igraph` bare, against a pool that holds `igraph` in both tracks
- **WHEN** the link pass runs
- **THEN** the launch refuses, and the message names the two store directories, `python:igraph`, and `r:igraph`
