# Design

## Context

`countArtifactsByRuns` (`src/state/artifacts.ts`) is the model: one grouped statement with `= ANY($2::text[])`, and `[]` for an empty list. `RUN_PROGRESS_JOINS` (`src/state/analyses-metrics.ts`) counts each row as a step and a `completed` row as done.

## Goals / Non-Goals

**Goals:**

- One statement for the step counts of a list of runs.

**Non-Goals:**

- A change to `RUN_PROGRESS_JOINS` or to the analysis and attention reads.
- A count of the steps that wait. A client gets it as `totalSteps - doneSteps - runningSteps`.

## Decisions

### The counts

The statement is `SELECT run_id, COUNT(*), COUNT(*) FILTER (WHERE status = 'completed'), COUNT(*) FILTER (WHERE status = 'running') ... GROUP BY run_id`. The rule for `totalSteps` and `doneSteps` is the rule of `RUN_PROGRESS_JOINS`. Thus a run gives the same counts in the run list and in the analysis summary.

### The analysis filter

The statement also filters on `analysis_id = $1`. Thus a run id of a different analysis gives no entry, as in `countArtifactsByRuns`. The primary key `(run_id, step_id)` serves the `run_id` filter.

## Risks / Trade-offs

- [A run that started before the pending seed has no row for the steps that did not start.] → Its `totalSteps` is low. `RUN_PROGRESS_JOINS` has the same limit.
