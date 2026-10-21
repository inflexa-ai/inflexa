## MODIFIED Requirements

### Requirement: One read gives a page of the artifact ledger of an analysis

The state module MUST give a paged read of the artifact ledger. The read takes a `Querier`, an analysis id, the filters, a sort, a limit, and an offset. It MUST give the entries of one page, `total`, and `extensionCounts`. `total` is the exact count of the rows that the filters select.

The read MUST give each ledger row of the analysis that the filters select. This includes an `input` row, a `step_output` row, and a row that carries `unrecoverable_at`. Each entry MUST carry these fields:

- `path`, the workspace-relative path of the row
- `size`, in bytes, as a number
- `fileType`, the `file_type` of the row, or `null`
- `role`, `input` or `step_output`
- `runId` and `stepId`, the `source_run` and the `source_step` of the row, or `null`
- `createdAt`, as the ledger stores it

The extension of a path is the text after the last dot of the file name, in lower case. The file name is the part of the path after the last `/`. A file name has no extension in each of these cases:

- It has no dot.
- Its only dot is its first character.
- It ends with a dot.

Thus `runs/r1/s1/figures/Volcano.PNG` has the extension `png`, and `a.tar.gz` has `gz`. `.bashrc` and `notes.` have no extension.

The filters MUST combine with AND. A filter that is absent MUST select each row:

- `runId` selects the rows whose `source_run` is equal to the value.
- `stepId` selects the rows whose `source_step` is equal to the value.
- `fileType` selects the rows whose `file_type` is equal to the value.
- `q` selects the rows whose path holds the value, with no regard to case. Each character of `q` MUST match only itself, thus `%` and `_` are not wildcards.
- `path` selects the row whose path is equal to the value. Case is significant.
- `extensions` is a list of extensions in lower case. It selects the rows whose path has an extension that is in the list. A row with no extension never matches. An empty list MUST select each row.

`extensionCounts` MUST give one entry `{ extension, count }` for each extension that a selected row has. It MUST give one entry with `extension` `null` for the selected rows that have no extension. It MUST give no entry with a count of 0. The entries MUST be in the order of the extension, and the `null` entry MUST come last. The sum of the counts MUST be equal to `total`. The entries do not depend on the sort, the limit, or the offset.

The sort `path` MUST order the entries by path. The sort `recent` MUST order the entries by `created_at`, newest first, and the path MUST break a tie. The read MUST give at most `limit` entries, from the position `offset` of the sort.

The read MUST send at most two statements, whatever the filters, the limit, and the size of the ledger. Each statement MUST select the rows of the one analysis through the leading column of the primary key. Thus the read never visits a row of a different analysis. A failed query MUST ride the error channel as a `DbError`.

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
- **THEN** it gives no entry, `total` is 3, and the counts of `extensionCounts` sum to 3

#### Scenario: The rows of a different analysis stay out

- **GIVEN** analysis `a1` with `runs/r1/s1/output/x.csv` and analysis `a2` with `runs/r9/s1/output/x.csv`
- **WHEN** the read runs for `a1` with `q` `x.csv`
- **THEN** it gives only the row of `a1`

#### Scenario: An exact path selects one row

- **GIVEN** analysis `a1` with `runs/r1/s1/output/de.csv` and `runs/r2/s1/output/de.csv.bak`
- **WHEN** the read runs with `path` `runs/r1/s1/output/de.csv`
- **THEN** it gives only that row, with the run `r1` and the step `s1`, and `total` is 1

#### Scenario: An exact path is case-sensitive

- **GIVEN** analysis `a1` with `runs/r1/s1/output/de.csv`
- **WHEN** the read runs with `path` `runs/r1/s1/output/DE.csv`
- **THEN** it gives no entry, and `total` is 0

#### Scenario: The figures by their extensions

- **GIVEN** analysis `a1` with `runs/r1/s1/figures/a.PNG`, `runs/r1/s1/output/b.svg`, `runs/r1/s1/output/c.csv`, and `runs/r1/s1/output/README`
- **WHEN** the read runs with `extensions` `png` and `svg`
- **THEN** it gives the two images in path order, and `total` is 2

#### Scenario: The count of each extension of a run

- **GIVEN** run `r1` of analysis `a1` with `runs/r1/s1/figures/a.png`, `runs/r1/s1/figures/b.PNG`, `runs/r1/s1/output/c.csv`, and `runs/r1/s1/output/README`
- **AND** run `r2` with `runs/r2/s1/output/d.csv`
- **WHEN** the read runs with `runId` `r1` and a limit of 1
- **THEN** it gives one entry, and `total` is 4
- **AND** `extensionCounts` is `csv` with 1, `png` with 2, and `null` with 1, in this order

#### Scenario: The counts follow the filters

- **GIVEN** analysis `a1` with `runs/r1/s1/figures/a.png` and `runs/r1/s1/output/c.csv`
- **WHEN** the read runs with `extensions` `png`
- **THEN** `extensionCounts` is `png` with 1 only

#### Scenario: The statement count does not grow with the page

- **WHEN** the read runs with a limit of 1, and again with a limit of 200 and each filter
- **THEN** each read sends the same count of statements, and the count is at most 2

### Requirement: The package root exports the artifact list reads

The root barrel of the package MUST export the paged ledger read, the grouped run count, and the types of their query and their entries. The type of an entry of `extensionCounts` is one of these types. An embedder MUST reach them with no deep import.

#### Scenario: An embedder imports the reads from the root

- **WHEN** an embedder imports the two reads and their types from `@inflexa-ai/harness`
- **THEN** the imports resolve
