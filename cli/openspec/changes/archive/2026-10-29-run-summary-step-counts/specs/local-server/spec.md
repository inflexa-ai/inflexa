## ADDED Requirements

### Requirement: A run summary gives the step counts of the run

Each run of `GET {A}/runs` and the run of `GET {A}/run/:runId` MUST carry `doneSteps`, `runningSteps`, and `totalSteps`. The counts come from the step ledger of the run:

- `doneSteps`: the steps that completed
- `runningSteps`: the steps that run now
- `totalSteps`: each step of the ledger of the run, the synthesis step included

A step that waits counts in `totalSteps` only. A run with no step in the ledger MUST give 0 for each count. The rule for `doneSteps` and `totalSteps` is the rule of the analysis summary.

The runs of one page MUST get their counts from one grouped read of the harness, whatever the page size. A failed count read MUST NOT fail the response. Then the three counts MUST be absent on each run of the response, and the failure MUST go to the log.

#### Scenario: The step counts of a page of runs

- **GIVEN** run `r1` with two steps that completed, one step that runs, and two steps that wait, and run `r2` with no step
- **WHEN** a client lists the runs of the analysis
- **THEN** `r1` has `doneSteps` 2, `runningSteps` 1, and `totalSteps` 5
- **AND** `r2` has `doneSteps` 0, `runningSteps` 0, and `totalSteps` 0
- **AND** the server sends one step count read for the page

#### Scenario: A failed step count read

- **GIVEN** a step count read that fails
- **WHEN** a client lists the runs of the analysis
- **THEN** the server answers 200, and no run has `doneSteps`, `runningSteps`, or `totalSteps`
