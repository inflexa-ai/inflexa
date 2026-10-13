# Spec Delta

## ADDED Requirements

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

The state module MUST give a read over each analysis. The read takes a `Querier`, a time, a list of run ids to skip, and a limit. The time is an ISO 8601 string in the form of `Date.prototype.toISOString`: UTC with milliseconds, the form of each `completed_at`. The read MUST give each terminal run whose `completed_at` is at or after the time. It MUST NOT give a run whose id is in the skip list. The terminal statuses are `completed`, `partial`, `failed`, and `canceled`. The entries MUST come newest first by `completed_at`, and `run_id` breaks a tie in descending order. The read MUST give at most `limit` entries.

Each entry MUST carry these fields:

- `analysisId` and `runId`
- `status`, the terminal status of the ledger, typed as a terminal run status
- `completedAt`, as the ledger stores it

The read MUST run as one SQL statement. It MUST walk the runs through an index on the completion time, thus it does not sort the whole run history. A failed query MUST ride the error channel as a `DbError`.

#### Scenario: The runs that ended since a time

- **GIVEN** run `r1` that completed before the time, runs `r2` and `r3` that ended after it in that order, and run `r4` that still runs
- **WHEN** the read runs with that time, an empty skip list, and a limit of 10
- **THEN** it gives `r3` and `r2`, the newest completion first

#### Scenario: A skipped run is absent

- **GIVEN** runs `r2` and `r3` that ended after the time
- **WHEN** the read runs with `r3` in the skip list
- **THEN** it gives `r2` only

#### Scenario: The limit bounds the result

- **GIVEN** 5 runs that ended after the time
- **WHEN** the read runs with a limit of 2
- **THEN** it gives the 2 newest

## MODIFIED Requirements

### Requirement: The package root exports the grouped reads

The root barrel of the package MUST export these reads and the types of their entries:

- the newest-run read
- the profile read
- the progress read of a list of runs
- the read of the runs that ended since a time, and the terminal run status type

An embedder MUST reach them with no deep import.

#### Scenario: An embedder imports the reads from the root

- **WHEN** an embedder imports the four reads and their entry types from `@inflexa-ai/harness`
- **THEN** the imports resolve
