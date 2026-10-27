## MODIFIED Requirements

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
