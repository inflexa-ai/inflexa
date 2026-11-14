# analysis-summary-reads Specification

## Purpose

Give an embedder the run state and the profile state of a page of analyses in a fixed count of Postgres reads. An embedder that lists analyses must not read the ledgers one time for each analysis.

## Requirements

### Requirement: One read gives the newest run of each analysis of a list

The state module MUST give a grouped read that takes a `Querier` and a list of analysis ids. It MUST give at most one entry for each analysis that has a run row. The entry MUST describe the newest run of that analysis. The newest run is the run with the latest `started_at`, and `run_id` breaks a tie in descending order.

Each entry MUST carry these fields:

- `analysisId` and `runId`
- `status`, the run status of the ledger
- `startedAt` and `completedAt`, as the ledger stores them
- `planTitle`: the `title` of the plan of the run, trimmed, when it is a string that is not blank. It is `null` when the run has no plan, or when the plan is gone or belongs to a different analysis. It is also `null` when the title is absent, blank, or not a string.
- `totalSteps`: the count of the step ledger rows of the run, the reserved synthesis row included
- `doneSteps`: the count of those rows whose status is `completed`
- `usage`: the token usage of the run, or `null`

The `usage` MUST be the sum of the usage of the step rows of the run. It holds one sum for each field of the token usage rollup. A field that no row reported MUST be absent. A run whose rows reported no field MUST give `null`, never an all-zero rollup. The value grows while the run runs, as each step ends. At the end of the run, it MUST equal the `usage` of the `data-run-completed` part of the run. This rule applies to a run whose steps all ended after the migration.

The read MUST run as one SQL statement for the whole list. It MUST find the newest run of each analysis through an index on the analysis and the start time. Thus its cost does not grow with the run history. It MUST count the step rows of only the newest run of each analysis. An empty list MUST give an empty result and send no query. A failed query MUST ride the error channel as a `DbError`.

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

#### Scenario: The usage of a run that runs

- **GIVEN** a running run with a completed step that reported 100 input tokens, and a second completed step that reported 50 input tokens and 20 output tokens
- **WHEN** the read gives the entry of that run
- **THEN** `usage` is `{ inputTokens: 150, outputTokens: 20 }`

#### Scenario: A run with no reported usage

- **GIVEN** a run whose step rows hold no usage
- **WHEN** the read gives the entry of that run
- **THEN** `usage` is `null`

#### Scenario: One statement serves the list

- **WHEN** the read runs for a list of 20 analyses
- **THEN** it sends one query

### Requirement: One read gives the profile state of each analysis of a list

The grouped data profile read of the state module MUST take a `Querier` and a list of analysis ids. It MUST give one entry for each analysis whose ledger row has a profile status. An analysis with no row, or with a cleared row whose status is null, MUST have no entry. That is the same collapsed absence as the single-analysis status read.

Each entry MUST carry these fields:

- `analysisId`
- `status`, the profile lifecycle status
- `startedAt`, the start of the latest profile attempt as the ledger stores it, or `null`
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

#### Scenario: A profile gives its start

- **GIVEN** an analysis whose profile started at a known time
- **WHEN** the read runs for that analysis
- **THEN** the entry has that time as `startedAt`

### Requirement: The package root exports the grouped reads

The root barrel of the package MUST export these reads and the types of their entries:

- the newest-run read
- the profile read
- the progress read of a list of runs
- the read of the runs in flight of a list of analyses, and the type of its input
- the read of the runs that ended since a time, and the terminal run status type

An embedder MUST reach them with no deep import.

#### Scenario: An embedder imports the reads from the root

- **WHEN** an embedder imports the five reads and their entry types from `@inflexa-ai/harness`
- **THEN** the imports resolve

### Requirement: One read gives the progress of each run of a list

The state module MUST give a grouped read that takes a `Querier` and a list of run ids. It MUST give one entry for each id that names a run row, and no entry for an id with no row. The entries MUST come newest first by `started_at`, and `run_id` breaks a tie in descending order.

Each entry MUST carry the fields of an entry of the newest-run read, with the same rules for `planTitle`, `totalSteps`, and `doneSteps`. Each entry MUST also carry `threadId`, the thread of the run as the ledger stores it, or `null`.

The plan title rule and the step count rule MUST have one SQL text in the package, which this read and the newest-run read share. The read MUST run as one SQL statement for the whole list. It MUST count the step rows of only the runs of the list. An empty list MUST give an empty result and send no query. A failed query MUST ride the error channel as a `DbError`.

#### Scenario: The progress of named runs

- **GIVEN** run `r1` of analysis `a1` in thread `t1`, with 4 step rows of which 1 is `completed`, and run `r2` of analysis `a2` with no thread
- **WHEN** the read runs for `[r1, r2, gone]`
- **THEN** it gives two entries: `r1` with `analysisId` `a1`, `threadId` `t1`, `totalSteps` 4, and `doneSteps` 1, and `r2` with `threadId` `null`

#### Scenario: A plan of a different analysis gives no title

- **GIVEN** a run whose `plan_id` names a plan of a different analysis
- **WHEN** the read gives the entry of that run
- **THEN** `planTitle` is `null`

#### Scenario: One statement serves the list

- **WHEN** the read runs for a list of 20 run ids
- **THEN** it sends one query

### Requirement: One read gives the runs that ended since a time

The state module MUST give a read over each analysis. The read takes a `Querier`, a time, and a limit. The time is an ISO 8601 string in the form of `Date.prototype.toISOString`: UTC with milliseconds, the form of each `completed_at`. The read MUST give each terminal run whose `completed_at` is at or after the time. The terminal statuses are `completed`, `partial`, `failed`, and `canceled`. The entries MUST come newest first by `completed_at`, and `run_id` breaks a tie in descending order. The read MUST give at most `limit` entries.

Each entry MUST carry these fields:

- `analysisId` and `runId`
- `status`, the terminal status of the ledger, typed as a terminal run status
- `completedAt`, as the ledger stores it

The read MUST run as one SQL statement. It MUST walk the runs through an index on the completion time, thus it does not sort the whole run history. A failed query MUST ride the error channel as a `DbError`.

#### Scenario: The runs that ended since a time

- **GIVEN** run `r1` that completed before the time, runs `r2` and `r3` that ended after it in that order, and run `r4` that still runs
- **WHEN** the read runs with that time and a limit of 10
- **THEN** it gives `r3` and `r2`, the newest completion first

#### Scenario: The limit bounds the result

- **GIVEN** 5 runs that ended after the time
- **WHEN** the read runs with a limit of 2
- **THEN** it gives the 2 newest

### Requirement: One read gives the runs in flight of a list of analyses

The state module MUST give a read that takes a `Querier` and `{ analysisIds, userId?, limit }`. The read MUST give each `running` run of the listed analyses, as entries of the progress read of a list of runs. The entries MUST come newest first by `started_at`, and `run_id` breaks a tie in descending order. A user id MUST narrow the result to the runs whose `user_id` equals it. A run with a null `user_id` MUST NOT match a user id. The read MUST give at most `limit` entries. The limit MUST be clamped to the range 1 to 200, the bounds of `listRecentThreads`.

The read MUST use the one SQL text of the plan title rule, the step count rule, and the usage rule. It MUST run as one SQL statement for the whole list. An empty list MUST give an empty result and send no query. A failed query MUST ride the error channel as a `DbError`.

#### Scenario: The runs in flight of one person

- **GIVEN** a running run of `u1` and a running run of `u2` in analysis `a1`, and a completed run of `u1` in `a1`
- **WHEN** the read runs for `[a1]` with the user id `u1`
- **THEN** it gives the running run of `u1` only, with its plan title, its step counts, and its usage

#### Scenario: The limit bounds the result

- **GIVEN** three running runs in analysis `a1`
- **WHEN** the read runs for `[a1]` with a limit of 2
- **THEN** it gives the two runs with the newest start

#### Scenario: One statement serves the list

- **WHEN** the read runs for a list of 20 analyses
- **THEN** it sends one query
