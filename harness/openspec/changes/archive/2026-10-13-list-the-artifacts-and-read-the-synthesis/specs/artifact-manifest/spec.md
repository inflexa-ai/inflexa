## MODIFIED Requirements

### Requirement: The artifact ledger helpers give a Result

`src/state/artifacts.ts` MUST export these helpers. Each helper takes a `Querier` first and returns
`ResultAsync<…, DbError>`:

- `upsertArtifact(pool, entry)` and `upsertArtifacts(pool, entries)`: the upserts of the artifact upsert semantics requirement.
- `queryInputArtifacts(pool, analysisId, paths)`: the `input` rows at the paths.
- `queryUnsyncedStepArtifacts(pool, resourceId, runId, stepId)`: the rows of the optional external sync tracking requirement.
- `queryStepArtifactPaths(pool, resourceId, runId, stepId, limit)`: the step outputs of a step, most consequential first.
- `queryAnalysisArtifacts(pool, analysisId)`: each artifact of an analysis, ordered by path.
- `queryArtifactPage(pool, analysisId, query)`: one page of the ledger of an analysis, and the count of the rows that its filters select.
- `countArtifactsByRuns(pool, analysisId, runIds)`: the count of the step outputs of each run of a list.
- `updateArtifactId(pool, resourceId, path, artifactId, fileType?)` and `updateFileIds(pool, pairs)`: the sync writes.

A driver failure MUST be an `err`, never a throw. Absence rides the `ok` channel as `[]` or `0`. A workflow body or a
step body changes an `err` into a throw with `unwrapOrThrow`. Each other caller keeps the Result.

#### Scenario: A driver failure is an err

- **GIVEN** a `Querier` whose query rejects
- **WHEN** the harness calls `upsertArtifacts`
- **THEN** it gives an `err` with the `op` `artifacts.upsertArtifacts`, and it does not throw

#### Scenario: No matching row is an empty ok

- **WHEN** the harness calls `queryInputArtifacts` with paths that no `input` row holds
- **THEN** it gives `ok([])`

## ADDED Requirements

### Requirement: One read gives a page of the artifact ledger of an analysis

The state module MUST give a paged read of the artifact ledger. The read takes a `Querier`, an analysis id, the filters, a sort, a limit, and an offset. It MUST give the entries of one page and `total`, the exact count of the rows that the filters select.

The read MUST give each ledger row of the analysis that the filters select. This includes an `input` row, a `step_output` row, and a row that carries `unrecoverable_at`. Each entry MUST carry these fields:

- `path`, the workspace-relative path of the row
- `size`, in bytes, as a number
- `fileType`, the `file_type` of the row, or `null`
- `role`, `input` or `step_output`
- `runId` and `stepId`, the `source_run` and the `source_step` of the row, or `null`
- `createdAt`, as the ledger stores it

The filters MUST combine with AND. A filter that is absent MUST select each row:

- `runId` selects the rows whose `source_run` is equal to the value.
- `stepId` selects the rows whose `source_step` is equal to the value.
- `fileType` selects the rows whose `file_type` is equal to the value.
- `q` selects the rows whose path holds the value, with no regard to case. Each character of `q` MUST match only itself, thus `%` and `_` are not wildcards.

The sort `path` MUST order the entries by path. The sort `recent` MUST order the entries by `created_at`, newest first, and the path MUST break a tie. The read MUST give at most `limit` entries, from the position `offset` of the sort.

The read MUST send at most two statements, whatever the limit and the size of the ledger. Each statement MUST select the rows of the one analysis through the leading column of the primary key. Thus the read never visits a row of a different analysis. A failed query MUST ride the error channel as a `DbError`.

#### Scenario: The figures that match a text

- **GIVEN** analysis `a1` with `runs/r1/s1/figures/Volcano.png` and `runs/r2/s3/figures/volcano_up.png` of the type `figure`, and `runs/r1/s1/output/volcano.csv` of the type `output`
- **WHEN** the read runs for `a1` with `fileType` `figure` and `q` `VOLCANO`
- **THEN** it gives the two figures in path order, each with its run and its step, and `total` is 2

#### Scenario: A wildcard character matches only itself

- **GIVEN** analysis `a1` with `runs/r1/s1/output/a_b.csv` and `runs/r1/s1/output/axb.csv`
- **WHEN** the read runs with `q` `a_b`
- **THEN** it gives only `runs/r1/s1/output/a_b.csv`

#### Scenario: The newest artifacts come first

- **GIVEN** three rows of analysis `a1` that were registered at different times
- **WHEN** the read runs with the sort `recent`
- **THEN** the newest row comes first

#### Scenario: A page past the end

- **GIVEN** analysis `a1` with 3 ledger rows
- **WHEN** the read runs with a limit of 2 and an offset of 4
- **THEN** it gives no entry, and `total` is 3

#### Scenario: The rows of a different analysis stay out

- **GIVEN** analysis `a1` with `runs/r1/s1/output/x.csv` and analysis `a2` with `runs/r9/s1/output/x.csv`
- **WHEN** the read runs for `a1` with `q` `x.csv`
- **THEN** it gives only the row of `a1`

#### Scenario: The statement count does not grow with the page

- **WHEN** the read runs with a limit of 1, and again with a limit of 200
- **THEN** each read sends the same count of statements, and the count is at most 2

### Requirement: One read gives the artifact count of each run of a list

The state module MUST give a grouped read that takes a `Querier`, an analysis id, and a list of run ids. It MUST give one entry `{ runId, count }` for each run of the list that has a `step_output` row of the analysis. A run with no such row MUST have no entry, and a caller reads it as 0. The count MUST cover the `step_output` rows only, thus an `input` row never counts.

The read MUST run as one SQL statement for the whole list. An empty list MUST give an empty result and send no query. A failed query MUST ride the error channel as a `DbError`.

The run-completed card MUST get its artifact count from this read, with the one run of the card.

#### Scenario: The counts of a page of runs

- **GIVEN** run `r1` with 3 step outputs, run `r2` with no step output, and an input row of the analysis
- **WHEN** the read runs for `[r1, r2]`
- **THEN** it gives one entry, `r1` with the count 3

#### Scenario: One statement serves the list

- **WHEN** the read runs for a list of 20 run ids
- **THEN** it sends one query

### Requirement: The package root exports the artifact list reads

The root barrel of the package MUST export the paged ledger read, the grouped run count, and the types of their query and their entries. An embedder MUST reach them with no deep import.

#### Scenario: An embedder imports the reads from the root

- **WHEN** an embedder imports the two reads and their types from `@inflexa-ai/harness`
- **THEN** the imports resolve
