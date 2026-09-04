## MODIFIED Requirements

### Requirement: Each plan step names its packages

In `PlanStepSchema`, the `packages` array MUST be a necessary field of every
planned step. Each entry MUST be a query in the one grammar of the
`package-identity` capability: an optional track prefix, a spelling, and
an optional exact version. The prefix names the track of the pool that the
link pass searches. A bare spelling searches both tracks. The persistence
schema MUST keep the field optional, thus a stored plan from before this
change still parses. The briefing MUST withhold the `packages` field from
the rendered task, because the link pass consumes it and a step agent must
not re-litigate it.

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

#### Scenario: An entry parses into a query

- **GIVEN** a step whose packages are `["python:igraph", "r:decoupleR", "scanpy", "numpy==1.26.4"]`
- **WHEN** the link pass parses the entries
- **THEN** the queries carry the tracks `python`, `r`, none, and none, with the spellings `igraph`, `decoupleR`, `scanpy`, and `numpy`

### Requirement: The plan validation refuses a package location

The shared plan validation MUST parse each package entry with `parseQuery`,
and it MUST report one issue for each parse error. The two callers of the
validation are the re-validation of `submit_plan` and the pre-launch
re-validation of a stored plan. The issue MUST name the step and the
offending entry. An absent `packages` array MUST pass, because the stored
plans from before this change carry none. The validation holds no parser
of its own, thus it cannot disagree with the link pass.

A `location` error refuses a path, a URL, or a store directory. An
`unsupported_specifier` error refuses a version specifier that is not
`==`, because a range such as `numpy>=1.26` otherwise becomes a package
name. An `unknown_prefix` error refuses a prefix that is not `python:` or
`r:`, and the issue MUST name the two permitted prefixes.

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
- **THEN** an issue names the step and the entry, and it names the `==` form

#### Scenario: A prefixed form passes

- **GIVEN** a step whose packages are `["python:igraph", "r:decoupleR==2.17.0"]`
- **WHEN** the plan validates
- **THEN** no package-form issue is reported

#### Scenario: An unknown prefix is refused

- **GIVEN** a step whose packages include `bioc:fgsea`
- **WHEN** the plan validates
- **THEN** an issue names the step and the entry, and it names `python:` and `r:` as the permitted prefixes

#### Scenario: A leading space does not defeat the prefix guard

- **GIVEN** a step whose packages include `" bioc:fgsea"`
- **WHEN** the plan validates
- **THEN** an issue names the step and the entry

### Requirement: A plan's packages link before the launch

When the farm-extension seam is bound, the launch MUST link the plan's
packages before the run reserves anything. The linked set is the union of
the queries of each step, and it goes into the farm of the analysis. The
union MUST dedupe equal queries only: two entries are one request when
their spelling, their track, and their version are equal. A bare entry
and a qualified entry of one spelling are two requests. The pass MUST pass
each query to the seam as it was parsed.

A pool miss MUST refuse the launch with an error that names the missing
spellings. A `collision` outcome MUST refuse the launch with an error that
names the two store directories and the two prefixed forms, written with
`formatQuery`. The harness MUST NOT name a remedy command, because the
remedy belongs to the embedder. The prefix is a plan form and not a
command, thus the refusal names it. Without a bound seam, the pass MUST
return at once.

#### Scenario: The link pass runs before the run

- **GIVEN** a bound seam and a plan whose packages the pool holds
- **WHEN** the launch runs
- **THEN** every named package links into the farm before the first sandbox action

#### Scenario: A pool miss refuses the launch

- **GIVEN** a plan that names a package the pool does not hold
- **WHEN** the launch runs
- **THEN** the launch refuses with the missing spellings, and no run starts

#### Scenario: No seam means no pass

- **GIVEN** no bound farm-extension seam
- **WHEN** the launch runs
- **THEN** the link pass returns at once, and the launch continues

#### Scenario: A prefixed entry reaches the seam with its track

- **GIVEN** a plan whose steps name `python:igraph` and `r:igraph`
- **WHEN** the link pass runs
- **THEN** the seam receives two queries with the spelling `igraph`, one with the track `python` and one with the track `r`

#### Scenario: Equal queries make one request

- **GIVEN** a plan whose steps name `scanpy` two times
- **WHEN** the link pass runs
- **THEN** the seam receives one query with the spelling `scanpy`

#### Scenario: A bare entry beside a qualified entry keeps its own refusal

- **GIVEN** a plan whose steps name `python:igraph` and `igraph`, against a pool that holds `igraph` in both tracks
- **WHEN** the link pass runs
- **THEN** the seam receives two queries, and the launch refuses on the bare one with `python:igraph` and `r:igraph` in the message

#### Scenario: Two spellings of one fold make two requests

- **GIVEN** a plan whose steps name `decoupler` and `decoupleR`, both bare
- **WHEN** the link pass runs
- **THEN** the seam receives two queries, `decoupler` and `decoupleR`, each with no track

#### Scenario: A collision refusal names the prefixed forms

- **GIVEN** a plan that names `igraph` bare, against a pool that holds `igraph` in both tracks
- **WHEN** the link pass runs
- **THEN** the launch refuses, and the message names the two store directories, `python:igraph`, and `r:igraph`
