# Design

## Context

`summarizeRuns` (`src/server/routes/runs.ts`) reads the artifact counts of a page with one call of `opts.countArtifacts`. `readArtifactCounts` gives `null` on a failure, and `toRunSummary` then omits `artifactCount`. The detail route `GET {A}/run/:runId` uses the same read for one run.

## Goals / Non-Goals

**Goals:**

- The three counts on each run of the list and on the detail, from one read for each response.

**Non-Goals:**

- A field for the steps that wait. A client gets it as `totalSteps - doneSteps - runningSteps`.
- A change to a TUI view.

## Decisions

### The model of the artifact count

A new option `countSteps` of `RunRoutesOpts` takes the harness helper `countStepsByRuns`. A new `readStepCounts` follows `readArtifactCounts`: one call for the run ids of the response, and `null` with a log line on a failure. A run with no entry gets 0 for each count.

The step counts and the artifact count are two reads. One read for the two counts needs a new harness statement over two tables, and it couples two ledgers that change apart.

### Optional fields

The three fields are optional on `RunSummary`, as `artifactCount` is. A false 0 for a failed read states that a run has no steps. Thus the fields are absent on a failure. A client test fixture that builds a `RunSummary` needs no change.

## Risks / Trade-offs

- [The release of the cli needs a harness version that exports `countStepsByRuns`.] → The cli CI links the harness of the working copy. The pin bump belongs to the developer.
