## ADDED Requirements

### Requirement: The run list finds the runs by a text

`GET {A}/runs` MUST take the query value `q`. It MUST select the runs whose run id holds the text, and the runs whose plan title holds the text. The match MUST have no regard to case, and each character of `q` MUST match only itself. The plan title is the `title` of the stored plan of the run. Thus a run with no plan, or with a plan that is gone, matches by its run id only. An absent or empty `q` MUST select each run.

`q` MUST narrow the runs that the other query values select:

- With `active=true`, the server selects the running runs that `q` selects. It ignores `threadId`, as it does with no `q`.
- With `threadId` and no `active=true`, the server selects the runs of the thread that `q` selects.
- With neither value, the server selects each run of the analysis that `q` selects.

The filter MUST apply before the page, and the order of the runs MUST stay newest first. With `active=true` or with no `threadId`, `total` MUST count the runs that the filters select. With `threadId` and no `active=true`, `total` is a lower bound. It counts the selected runs up to the end of the page, plus one when a later page has a selected run.

The harness ledger MUST do the filter. The route MUST NOT read a run that `q` does not select, and it MUST NOT filter a page after the read.

#### Scenario: A text finds a run by its title

- **GIVEN** analysis `a1` with run `r1` of the plan titled "Differential expression" and run `r2` of the plan titled "Pathway enrichment"
- **WHEN** a client sends `GET /api/v1/analyses/a1/runs?q=PATHWAY`
- **THEN** the server answers with `r2` only, with its `planTitle`, and `total` is 1

#### Scenario: A text finds a run by a part of its id

- **GIVEN** analysis `a1` with run `5f3a9c` and run `7b21e0`
- **WHEN** a client sends `GET /api/v1/analyses/a1/runs?q=3a9`
- **THEN** the server answers with run `5f3a9c` only

#### Scenario: The text selects the runs before the page

- **GIVEN** analysis `a1` with 150 runs whose plan title holds "volcano", and 300 newer runs whose title does not
- **WHEN** a client sends `GET /api/v1/analyses/a1/runs?q=volcano&perPage=100`
- **THEN** the server answers with the 100 newest runs that match, `total` is 150, and `hasMore` is true

#### Scenario: The text combines with the active runs

- **GIVEN** analysis `a1` with a running run and a completed run whose plan titles hold "volcano"
- **WHEN** a client sends `GET /api/v1/analyses/a1/runs?active=true&q=volcano`
- **THEN** the server answers with the running run only, and `total` is 1

#### Scenario: The active runs take precedence over the thread

- **GIVEN** analysis `a1` with a running run `r1` in thread `t2` whose plan title holds "volcano"
- **WHEN** a client sends `GET /api/v1/analyses/a1/runs?active=true&threadId=t1&q=volcano`
- **THEN** the server answers with `r1`, and `total` is 1

#### Scenario: An empty text selects each run

- **WHEN** a client sends `GET /api/v1/analyses/a1/runs?q=`
- **THEN** the server answers with the same runs and the same `total` as with no `q`

## MODIFIED Requirements

### Requirement: The server lists the artifact ledger of an analysis

`GET {A}/artifacts` MUST give one page of the artifact ledger of the analysis in the list shape, with the key `artifacts`. Each item MUST carry these fields:

- `path`, relative to the workspace folder of the analysis. `GET {A}/files?path=` takes the same form.
- `size`, in bytes
- `fileType`, or `null`
- `role`, `input` or `step_output`
- `runId` and `stepId`, or `null`
- `createdAt`, the time of the first registration of the path

The query values `runId`, `stepId`, and `fileType` MUST each select the rows with that exact value. The query value `path` MUST select the row whose path is equal to the value, and case is significant. The query value `q` MUST select the rows whose path holds the text, with no regard to case. An absent or empty value MUST select each row. The filters MUST combine with AND, and `total` MUST count the rows that they select.

The extension of a path is the text after the last dot of its file name, in lower case. A file name has no extension in each of these cases:

- It has no dot.
- Its only dot is its first character.
- It ends with a dot.

The query value `extension` MUST be a list of extensions with a comma between them, for example `png,svg`. It MUST select the rows whose path has one of these extensions, with no regard to case. The server MUST remove the spaces at the start and the end of each member, and it MUST ignore an empty member. A value with no member MUST select each row.

The response MUST add `extensionCounts` to the list shape. It MUST give one entry `{ extension, count }` for each extension that a selected row has, in the order of the extension. It MUST give one last entry with `extension` `null` for the selected rows that have no extension. It MUST give no entry with a count of 0. The counts MUST sum to `total`, and they MUST NOT depend on the page.

The `sort` query value MUST select the order. `path` orders by the path, and it is the default. `recent` orders by `createdAt`, newest first, and the path breaks a tie. An absent or empty `sort` MUST select the default. A different value MUST give 400 `validation_error` with the field error under `sort`.

Each request MUST send one paged read of the harness ledger, with the limit and the offset of the page. The count of its statements MUST NOT depend on the page size. The route needs the harness runtime, thus it MUST answer 503 `unavailable` before the phase is `ready`. A failed ledger read MUST give 500 `internal_error`.

#### Scenario: The volcano figures of each run

- **GIVEN** analysis `a1` with a volcano figure in run `r1`, a volcano figure in run `r2`, and a volcano table of the type `output`
- **WHEN** a client sends `GET /api/v1/analyses/a1/artifacts?fileType=figure&q=volcano`
- **THEN** the server answers with the two figures, each with its `runId` and its `stepId`, and `total` is 2

#### Scenario: The newest artifacts first

- **WHEN** a client sends `GET /api/v1/analyses/a1/artifacts?sort=recent`
- **THEN** the item with the newest `createdAt` comes first

#### Scenario: A bad sort value

- **WHEN** a client sends `GET /api/v1/analyses/a1/artifacts?sort=size`
- **THEN** the server answers 400 `validation_error` with a field error under `sort`

#### Scenario: One read for each page

- **WHEN** a client sends `GET /api/v1/analyses/a1/artifacts?page=2&perPage=50`
- **THEN** the server sends one ledger read with the limit 50 and the offset 100

#### Scenario: A link finds the run of a file

- **GIVEN** analysis `a1` with `runs/r1/s1/output/de.csv` and `runs/r2/s1/output/de.csv.bak`
- **WHEN** a client sends `GET /api/v1/analyses/a1/artifacts?path=runs/r1/s1/output/de.csv`
- **THEN** the server answers with that one item, with `runId` `r1` and `stepId` `s1`, and `total` is 1

#### Scenario: The figures of a run by their extensions

- **GIVEN** run `r1` of analysis `a1` with `runs/r1/s1/figures/a.PNG`, `runs/r1/s1/figures/b.svg`, and `runs/r1/s1/output/c.csv`
- **WHEN** a client sends `GET /api/v1/analyses/a1/artifacts?runId=r1&extension=png,%20SVG,`
- **THEN** the server sends one ledger read with the extensions `png` and `svg`
- **AND** it answers with the two figures, and `total` is 2

#### Scenario: The count of each extension of a run

- **GIVEN** run `r1` of analysis `a1` with two PNG files, one CSV file, and the file `README`
- **WHEN** a client sends `GET /api/v1/analyses/a1/artifacts?runId=r1&perPage=1`
- **THEN** the server answers with one item, and `total` is 4
- **AND** `extensionCounts` is `[{ "extension": "csv", "count": 1 }, { "extension": "png", "count": 2 }, { "extension": null, "count": 1 }]`
