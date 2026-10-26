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
- `queryArtifactOrigins(pool, analysisId, paths)`: the run and the step of each path of a list that has a row.
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

### Requirement: The package root exports the artifact list reads

The root barrel of the package MUST export the paged ledger read, the origin read, and the grouped run count. It MUST also export the types of their query and their entries. The type of an entry of `extensionCounts` is one of these types. An embedder MUST reach them with no deep import.

#### Scenario: An embedder imports the reads from the root

- **WHEN** an embedder imports the reads and their types from `@inflexa-ai/harness`
- **THEN** the imports resolve

## ADDED Requirements

### Requirement: One read gives the origin of each path of a list

The state module MUST give a read that takes a `Querier`, an analysis id, and a list of workspace-relative paths. It MUST give one entry `{path, runId, stepId}` for each path of the list that has a ledger row of the analysis. `runId` and `stepId` are the `source_run` and the `source_step` of the row, or `null`. A path with no row MUST have no entry.

The read MUST run as one SQL statement for the whole list, through the key `(analysis_id, path)`. An empty list MUST give an empty result and send no query. A failed query MUST ride the error channel as a `DbError`. The caller bounds the length of the list.

#### Scenario: The origins of a page of paths

- **GIVEN** analysis `a1` with the step output `runs/r1/s1/output/de.csv` of run `r1` and step `s1`
- **AND** the input row `data/inputs/f1/counts.csv` of `a1`, and a row of analysis `a2` at `runs/r1/s1/output/de.csv`
- **WHEN** the read runs for `a1` with `runs/r1/s1/output/de.csv`, `data/inputs/f1/counts.csv`, and `runs/r1/s1/output/none.csv`
- **THEN** it gives two entries: `de.csv` with `r1` and `s1`, and `counts.csv` with `null` for each
- **AND** the path `none.csv` has no entry

#### Scenario: One statement serves the list

- **WHEN** the read runs for a list of 200 paths
- **THEN** it sends one query

#### Scenario: An empty list

- **WHEN** the read runs for an empty list
- **THEN** it gives `ok([])` and sends no query
