## MODIFIED Requirements

### Requirement: Analysis read and write functions

The system SHALL provide `listAnalyses()`, `listAnalysesByAnchor(anchorId)`, `listAnalysesByProject(projectId)`, `getAnalysis(id)`, `insertAnalysis(analysis)`, `renameAnalysis(id, name, slug)`, `updateAnalysisProject(id, projectId|null)`, and `deleteAnalysis(id)`, all returning `Result<…, DbError>`. The three list functions SHALL order by `created_at` descending. There SHALL be no `archiveAnalysis` (no archive feature). `getAnalysis` SHALL match the exact id only, never a name or a slug, and SHALL give `null` when no row has the id: the local server reads it for an id that a route path carries, where a name hit would be wrong. A reference that a person types still goes through the id-or-name resolver.

#### Scenario: Insert then list an analysis

- **WHEN** `insertAnalysis(analysis)` succeeds
- **THEN** the row's columns equal the entity's fields and it appears in `listAnalyses()`

#### Scenario: List by anchor and project, newest first

- **WHEN** analyses exist under anchor A and project P
- **THEN** `listAnalysesByAnchor(A)` returns those homed at A and `listAnalysesByProject(P)` those grouped under P, each ordered by `created_at` descending

#### Scenario: Targeted project update signals not-found

- **WHEN** `updateAnalysisProject(id, projectId)` runs
- **THEN** it issues one `UPDATE … SET project_id = ?, updated_at = ? WHERE id = ?` and returns the rows-changed count (`0` when no such analysis exists)

#### Scenario: An id lookup never matches a name

- **WHEN** `getAnalysis("trial")` runs and an analysis has the name `trial` but a different id
- **THEN** it returns `null`

## ADDED Requirements

### Requirement: Paged reads serve the lists of the local server

The system SHALL provide one paged read for each list that the local server gives: `listAnalysisPage({ projectId, limit, offset })`, `listProjectPage({ limit, offset })`, and `listAnalysisInputPage(analysisId, { limit, offset })`, each returning one page and the count of all rows of the filter. `listAnalysisPage` SHALL give each analysis with the cached path of its anchor, and SHALL keep an analysis whose anchor row is gone, with a `null` path. `listProjectPage` SHALL give each project with its analysis count in the same statement, never one count query for each project. The analysis and project pages SHALL order newest first, with `id` as the tie-break of `created_at`, so two pages never overlap. The system SHALL also provide `countAnalysisInputs(analysisId)`.

#### Scenario: A project page counts in one statement

- **GIVEN** two projects, one with two analyses
- **WHEN** `listProjectPage({ limit: 100, offset: 0 })` runs
- **THEN** it returns both projects with the counts 2 and 0, and a total of 2, from one statement

#### Scenario: Pages do not overlap on a shared creation time

- **GIVEN** three analyses with the same `created_at`
- **WHEN** two pages of size 2 are read
- **THEN** each analysis appears on exactly one page
