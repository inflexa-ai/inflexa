## ADDED Requirements

### Requirement: Run listing prioritizes non-terminal state before terminal history

`inspect_run` list mode SHALL order runs deterministically as running newest-first, suspended newest-first, then terminal runs newest-first. The ordering SHALL be applied before pagination. List mode SHALL accept optional `page` and `pageSize`, defaulting to page 1 and 50 rows, with `pageSize` limited to 100, and SHALL return `runs`, `total`, `page`, `pageSize`, and `hasMore`.

#### Scenario: Old running run precedes newer completed runs

- **GIVEN** a running run started before more than one completed run
- **WHEN** `inspect_run` is called without a `runId`
- **THEN** the running run appears before every completed run in the result

#### Scenario: Suspended runs follow running runs

- **GIVEN** an analysis has running, suspended, and terminal runs
- **WHEN** the first list page is inspected
- **THEN** running rows appear first, suspended rows next, and terminal rows last
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

`inspect_run` targeted mode SHALL return `inspectionState` as `not_found`, `in_progress`, `suspended`, or `terminal`. A found result SHALL retain the run's domain status. An in-progress result SHALL carry `elapsedMs` and state directly that results are not ready. A suspended result SHALL state that the run is not progressing until resumed. Step summary paths and run synthesis paths SHALL be advertised only when `inspectionState` is `terminal`, while preserving the existing per-step and synthesis-outcome rules that determine which terminal paths can exist.

#### Scenario: Running run is unmistakably in progress

- **GIVEN** a run row with `status: "running"`
- **WHEN** it is inspected by id without waiting
- **THEN** the result has `inspectionState: "in_progress"`
- **AND** it carries the underlying running status, start time, elapsed milliseconds, and prose that results are not ready
- **AND** it advertises no summary or synthesis paths

#### Scenario: Suspended run returns immediately

- **GIVEN** a run row with `status: "suspended_insufficient_funds"`
- **WHEN** it is inspected by id
- **THEN** the result has `inspectionState: "suspended"`
- **AND** it explains that the run must be resumed before it can progress
- **AND** it advertises no summary or synthesis paths

#### Scenario: Terminal run exposes only paths that can exist

- **GIVEN** a terminal run with completed and unstarted steps and a recorded synthesis outcome
- **WHEN** it is inspected by id
- **THEN** the result has `inspectionState: "terminal"`
- **AND** it exposes per-step summary paths only for eligible executed steps
- **AND** it exposes a synthesis path only when the synthesis outcome is `produced`

#### Scenario: Missing run is a normal state

- **WHEN** the requested run does not exist in the current analysis
- **THEN** the tool returns `inspectionState: "not_found"` on the success channel

### Requirement: Targeted inspection can wait for terminal state within a cutoff

`inspect_run` targeted mode SHALL accept `waitForTerminalSeconds` as an optional integer from 1 through 30, valid only when `runId` is present. For a running run, the tool SHALL re-read the run ledger at an approximately one-second interval until the run leaves `running`, the requested cutoff expires, or the request signal aborts. Terminal, suspended, and missing runs SHALL return immediately. A cutoff SHALL return a successful in-progress result with wait metadata including `requestedSeconds` and `cutoffReached: true`; it SHALL NOT be an error.

#### Scenario: Run becomes terminal during the wait

- **GIVEN** a running run and `waitForTerminalSeconds: 30`
- **WHEN** its ledger status becomes terminal before 30 seconds elapse
- **THEN** `inspect_run` returns promptly with `inspectionState: "terminal"`
- **AND** `cutoffReached` is false

#### Scenario: Wait reaches its cutoff

- **GIVEN** a run remains running for the entire requested wait
- **WHEN** the cutoff elapses
- **THEN** `inspect_run` returns `inspectionState: "in_progress"`
- **AND** its wait metadata carries the requested seconds and `cutoffReached: true`

#### Scenario: Waiting is canceled with the chat turn

- **GIVEN** a targeted wait is in progress
- **WHEN** `ctx.signal` aborts
- **THEN** the wait stops promptly
- **AND** cancellation follows the loop's fatal-cancellation path rather than becoming an in-progress result

#### Scenario: Invalid wait parameters are rejected

- **WHEN** `waitForTerminalSeconds` is outside 1 through 30 or is supplied without `runId`
- **THEN** input validation fails without querying run state

### Requirement: A workflow cannot wait for its own terminal state

When `inspect_run` executes under a `RunSession` and the requested `runId` equals `ctx.session.runFrame.runId`, the tool SHALL NOT wait for terminal state. It SHALL return immediately with the current inspection state and explain that the enclosing workflow cannot finish while its current step waits for itself.

#### Scenario: Sandbox agent requests a self-run wait

- **GIVEN** a sandbox agent executing inside run `R`
- **WHEN** it calls `inspect_run` with `runId: "R"` and `waitForTerminalSeconds`
- **THEN** the tool performs no wait loop
- **AND** it immediately reports that self-waiting cannot reach terminal state
