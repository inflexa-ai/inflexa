# Spec Delta

## MODIFIED Requirements

### Requirement: Analysis read and write functions

The system MUST give `listAnalyses()`, `listAnalysesByAnchor(anchorId)`, `listAnalysesByProject(projectId)`, `getAnalysis(id)`, `insertAnalysis(analysis)`, `renameAnalysis(id, name, slug)`, `updateAnalysisProject(id, projectId|null)`, `recordAnalysisActivity(id, atMs)`, and `deleteAnalysis(id)`, all returning `Result<…, DbError>`. The three list functions MUST order by `created_at` descending. There MUST be no `archiveAnalysis` (no archive feature). `getAnalysis` MUST match the exact id only, never a name or a slug, and MUST give `null` when no row has the id: the local server reads it for an id that a route path carries, where a name hit would be wrong. A reference that a person types still goes through the id-or-name resolver.

The `last_activity_at` column of an analysis MUST never be lower than its `updated_at`. `insertAnalysis` MUST write `last_activity_at` equal to `created_at`. Each write that sets `updated_at` of an analysis row MUST raise `last_activity_at` to at least that time in the same statement: `renameAnalysis`, `updateAnalysisProject`, and the clear of the project in `deleteProject`. `recordAnalysisActivity(id, atMs)` MUST be one `UPDATE … SET last_activity_at = MAX(last_activity_at, ?) WHERE id = ?`. It MUST leave `updated_at` as it is, and it MUST return the rows-changed count (`0` when no such analysis exists).

#### Scenario: Insert then list an analysis

- **WHEN** `insertAnalysis(analysis)` succeeds
- **THEN** the row's columns equal the entity's fields and it appears in `listAnalyses()`
- **AND** its `last_activity_at` equals its `created_at`

#### Scenario: List by anchor and project, newest first

- **WHEN** analyses exist under anchor A and project P
- **THEN** `listAnalysesByAnchor(A)` returns those homed at A and `listAnalysesByProject(P)` those grouped under P, each ordered by `created_at` descending

#### Scenario: Targeted project update signals not-found

- **WHEN** `updateAnalysisProject(id, projectId)` runs
- **THEN** it issues one `UPDATE` that sets `project_id`, `updated_at`, and the raised `last_activity_at` for `WHERE id = ?`, and returns the rows-changed count (`0` when no such analysis exists)

#### Scenario: An id lookup never matches a name

- **WHEN** `getAnalysis("trial")` runs and an analysis has the name `trial` but a different id
- **THEN** it returns `null`

#### Scenario: An activity record never lowers the time

- **GIVEN** an analysis whose `last_activity_at` is `T`
- **WHEN** `recordAnalysisActivity(id, T - 1000)` runs
- **THEN** `last_activity_at` stays `T`, and `updated_at` does not change

### Requirement: Paged reads serve the lists of the local server

The system MUST give one paged read for each list that the local server gives: `listAnalysisPage({ projectId, sort, limit, offset })`, `listProjectPage({ limit, offset })`, and `listAnalysisInputPage(analysisId, { limit, offset })`, each returning one page and the count of all rows of the filter. `listAnalysisPage` MUST give each analysis with the cached path of its anchor and its `last_activity_at`. It MUST keep an analysis whose anchor row is gone, with a `null` path. `listProjectPage` MUST give each project with its analysis count in the same statement, never one count query for each project. The project page, and the analysis page with the sort `created`, MUST order newest first by `created_at`. The analysis page with the sort `activity` MUST order newest first by `last_activity_at`, through the index of that column. Each order MUST break a tie with `id`, so two pages never overlap. The system MUST also provide `countAnalysisInputs(analysisId)`.

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
