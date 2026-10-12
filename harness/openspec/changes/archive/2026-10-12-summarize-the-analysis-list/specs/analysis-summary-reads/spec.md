# Spec Delta

## Purpose

Give an embedder the run state and the profile state of a page of analyses in a fixed count of Postgres reads. An embedder that lists analyses must not read the ledgers one time for each analysis.

## ADDED Requirements

### Requirement: One read gives the newest run of each analysis of a list

The state module MUST give a grouped read that takes a `Querier` and a list of analysis ids. It MUST give at most one entry for each analysis that has a run row. The entry MUST describe the newest run of that analysis. The newest run is the run with the latest `started_at`, and `run_id` breaks a tie in descending order.

Each entry MUST carry these fields:

- `analysisId` and `runId`
- `status`, the run status of the ledger
- `startedAt` and `completedAt`, as the ledger stores them
- `planTitle`: the `title` of the plan of the run, trimmed, when it is a string that is not blank. It is `null` when the run has no plan, or when the plan is gone or belongs to a different analysis. It is also `null` when the title is absent, blank, or not a string.
- `totalSteps`: the count of the step ledger rows of the run, the reserved synthesis row included
- `doneSteps`: the count of those rows whose status is `completed`

The read MUST run as one SQL statement for the whole list. It MUST find the newest run of each analysis through an index on the analysis and the start time, thus its cost does not grow with the run history. It MUST count the step rows of only the newest run of each analysis. An empty list MUST give an empty result and send no query. A failed query MUST ride the error channel as a `DbError`.

#### Scenario: The newest run of each analysis

- **GIVEN** analysis `a1` with an older run `r1` and a newer run `r2`, and analysis `a2` with no run
- **WHEN** the read runs for `[a1, a2]`
- **THEN** it gives one entry, for `a1`, with `runId` `r2`

#### Scenario: The step counts come from the ledger

- **GIVEN** a run with 5 step rows, the synthesis row included, and 2 of them `completed`
- **WHEN** the read gives the entry of that run
- **THEN** `totalSteps` is 5 and `doneSteps` is 2

#### Scenario: A plan of a different analysis gives no title

- **GIVEN** a run whose `plan_id` names a plan of a different analysis
- **WHEN** the read gives the entry of that run
- **THEN** `planTitle` is `null`

#### Scenario: One statement serves the list

- **WHEN** the read runs for a list of 20 analyses
- **THEN** it sends one query

### Requirement: One read gives the profile state of each analysis of a list

The grouped data profile read of the state module MUST take a `Querier` and a list of analysis ids. It MUST give one entry for each analysis whose ledger row has a profile status. An analysis with no row, or with a cleared row whose status is null, MUST have no entry. That is the same collapsed absence as the single-analysis status read.

Each entry MUST carry these fields:

- `analysisId`
- `status`, the profile lifecycle status
- `completedAt`, as the ledger stores it, or `null`
- `profiledFiles`: the count of the dataset files of the stored profile result. The rule is the dataset file count of the profile view. It is `null` when the row has no result or when the result cannot establish the count.

The read MUST run as one SQL statement for the whole list. It MUST read only the parts of the stored result that the count needs. An empty list MUST give an empty result and send no query. A failed query MUST ride the error channel as a `DbError`.

#### Scenario: A completed profile gives its file count

- **GIVEN** an analysis whose completed profile result has a partition with 12 kept files
- **WHEN** the read runs for that analysis
- **THEN** the entry has the status `completed`, the completion time of the row, and `profiledFiles` 12

#### Scenario: A cleared profile has no entry

- **GIVEN** an analysis whose profile row was cleared to a null status
- **WHEN** the read runs for that analysis
- **THEN** it gives no entry for that analysis

#### Scenario: A running profile has no count

- **GIVEN** an analysis whose first profile is `running` and has no result
- **WHEN** the read runs for that analysis
- **THEN** the entry has the status `running` and `profiledFiles` `null`

### Requirement: The package root exports the grouped reads

The root barrel of the package MUST export the two grouped reads and the types of their entries. An embedder MUST reach them with no deep import.

#### Scenario: An embedder imports the reads from the root

- **WHEN** an embedder imports the two grouped reads and their entry types from `@inflexa-ai/harness`
- **THEN** the imports resolve
