## MODIFIED Requirements

### Requirement: Paged reads serve the lists of the local server

The system MUST give one paged read for each list that the local server gives: `listAnalysisPage({ projectId, sort, limit, offset })`, `listProjectPage({ limit, offset })`, `listAnalysisInputPage(analysisId, { limit, offset })`, and `listPins({ limit, offset })`, each returning one page and the count of all rows of the filter. `listAnalysisPage` MUST give each analysis with the cached path of its anchor and its `last_activity_at`. It MUST keep an analysis whose anchor row is gone, with a `null` path. `listProjectPage` MUST give each project with its analysis count in the same statement, never one count query for each project. The project page, and the analysis page with the sort `created`, MUST order newest first by `created_at`. The analysis page with the sort `activity` MUST order newest first by `last_activity_at`, through the index of that column. The pin page MUST order oldest first by `created_at`. Each order MUST break a tie with `id`, so two pages never overlap. The system MUST also provide `countAnalysisInputs(analysisId)`.

The system MUST give `getProjectWithCount(id)`. It gives the project with exactly this id and its analysis count in one statement, or `null` when no row has the id. A name MUST NOT match.

#### Scenario: A project page counts in one statement

- **GIVEN** two projects, one with two analyses
- **WHEN** `listProjectPage({ limit: 100, offset: 0 })` runs
- **THEN** it returns both projects with the counts 2 and 0, and a total of 2, from one statement

#### Scenario: Pages do not overlap on a shared creation time

- **GIVEN** three analyses with the same `created_at`
- **WHEN** two pages of size 2 are read
- **THEN** each analysis appears on exactly one page

#### Scenario: The activity order

- **GIVEN** an older analysis with a newer `last_activity_at`
- **WHEN** `listAnalysisPage` runs with the sort `activity`
- **THEN** the older analysis comes first

#### Scenario: One project with its count

- **GIVEN** a project with two analyses
- **WHEN** `getProjectWithCount(id)` runs with its id
- **THEN** it returns the project with a count of 2, and `null` for an unknown id

#### Scenario: The pin page

- **GIVEN** a pin of `/b`, and then a pin of `/a`
- **WHEN** `listPins({ limit: 1, offset: 0 })` runs
- **THEN** it returns the pin of `/b` and a total of 2

## ADDED Requirements

### Requirement: Pin functions

The system MUST give these functions, each returning `Result<…, DbError>`:

- `addPin({ path, label, isDir })`: it mints the id and the times, and inserts the pin in one statement. When a pin of the path exists, it MUST keep that pin and give it. The result tells a new pin from an existing pin.
- `removePin(id)`: one `DELETE` that returns the rows-changed count, `0` for an unknown id.

#### Scenario: A second add keeps the first pin

- **GIVEN** a pin of `/data/study` with the label `Study`
- **WHEN** `addPin({ path: "/data/study", label: "Other", isDir: true })` runs
- **THEN** it gives the first pin with the label `Study`, marked as an existing pin, and `picker_pins` holds one row

### Requirement: Recent file functions

The system MUST give these functions, each returning `Result<…, DbError>`:

- `recordRecentFile({ path, isDir, analysisId, cap })`: in one transaction, it inserts the row of the path in its scope, or moves `updated_at` of the existing row. Then it deletes the oldest rows of the same scope past `cap`.
- `listRecentFiles({ analysisId, limit })`: the newest `limit` rows of one scope, by `updated_at` with `id` to break a tie. A `null` `analysisId` is the machine scope.

#### Scenario: The cap of a scope

- **GIVEN** 3 rows of analysis `a1`, and 1 row of the machine scope
- **WHEN** `recordRecentFile` runs for a new path of `a1` with `cap` 3
- **THEN** `a1` holds 3 rows without its oldest row, and the machine scope still holds its row
