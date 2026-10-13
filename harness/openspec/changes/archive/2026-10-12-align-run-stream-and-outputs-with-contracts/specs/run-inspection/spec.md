## MODIFIED Requirements

### Requirement: Run listing prioritizes non-terminal state before terminal history

`inspect_run` list mode SHALL order runs deterministically as running newest-first, then terminal runs newest-first. A `suspended_insufficient_funds` run is a terminal run. The ordering SHALL be applied before pagination. List mode SHALL accept optional `page` and `pageSize`, defaulting to page 1 and 50 rows, with `pageSize` limited to 100, and SHALL return `runs`, `total`, `page`, `pageSize`, and `hasMore`.

#### Scenario: Old running run precedes newer completed runs

- **GIVEN** a running run started before more than one completed run
- **WHEN** `inspect_run` is called without a `runId`
- **THEN** the running run appears before every completed run in the result

#### Scenario: Suspended runs follow running runs

- **GIVEN** an analysis has running, suspended, and completed runs
- **WHEN** the first list page is inspected
- **THEN** running rows appear first, and the suspended and completed rows follow them as one group
- **AND** rows within each group are ordered by `startedAt` descending

#### Scenario: A capped list discloses omitted history

- **GIVEN** more runs exist than fit on the requested page
- **WHEN** `inspect_run` returns that page
- **THEN** `total` reports the full matching count
- **AND** `hasMore` is true
- **AND** the caller can request the next page

#### Scenario: List-only pagination inputs are rejected in targeted mode

- **WHEN** `inspect_run` receives `runId` together with `page` or `pageSize`
- **THEN** input validation fails with a model-correctable error

### Requirement: Targeted inspection exposes readiness as a top-level state

`inspect_run` targeted mode SHALL return `inspectionState` as `not_found`, `in_progress`, `suspended`, or `terminal`. A found result SHALL retain the run's domain status. An in-progress result SHALL carry `elapsedMs` and state directly that results are not ready. A suspended result is the state of a run whose row reads `suspended_insufficient_funds`. It SHALL state that the host suspended the run, that the run does not progress, and that a new run of the plan can start. Step summary paths and run synthesis paths SHALL be advertised only when `inspectionState` is `terminal` or `suspended`, while preserving the existing per-step and synthesis-outcome rules that determine which terminal paths can exist.

#### Scenario: Running run is unmistakably in progress

- **GIVEN** a run row with `status: "running"`
- **WHEN** it is inspected by id without waiting
- **THEN** the result has `inspectionState: "in_progress"`
- **AND** it carries the underlying running status, start time, elapsed milliseconds, and prose that results are not ready
- **AND** it advertises no summary or synthesis paths

#### Scenario: Suspended run returns immediately

- **GIVEN** a run row with `status: "suspended_insufficient_funds"` and a completed step
- **WHEN** it is inspected by id
- **THEN** the result has `inspectionState: "suspended"`
- **AND** it explains that the host suspended the run and that a new run of the plan can start
- **AND** it advertises the summary path of the completed step

#### Scenario: Terminal run exposes only paths that can exist

- **GIVEN** a terminal run with completed and unstarted steps and a recorded synthesis outcome
- **WHEN** it is inspected by id
- **THEN** the result has `inspectionState: "terminal"`
- **AND** it exposes per-step summary paths only for eligible executed steps
- **AND** it exposes a synthesis path only when the synthesis outcome is `produced`

#### Scenario: Missing run is a normal state

- **WHEN** the requested run does not exist in the current analysis
- **THEN** the tool returns `inspectionState: "not_found"` on the success channel
