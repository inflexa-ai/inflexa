# data-model-db-access Specification

## Purpose
The typed, `Result`-returning read/write layer over the data-model tables — columnar row mapping, id-or-name resolution in one id-priority query, targeted updates, and count/recovery helpers — with no filesystem access or business logic.

## Requirements

### Requirement: Columnar row mapping

For each entity table, the access layer SHALL define a `COLS` column-list constant, a `Row` type mirroring the SQL columns, and a `fromRow` mapper, reading typed columns directly (NOT `SELECT data` + `JSON.parse`). The `COLS` list, the `Row` type, and `fromRow` SHALL follow the identity → core → foreign-key ordering. A name column read back from the DB SHALL be re-branded with `asStr256` (a trusted source).

#### Scenario: Reads map columns, not a blob

- **WHEN** an anchor, project, or analysis is read
- **THEN** the query selects the `COLS` list and `fromRow` builds the entity from typed columns, with no JSON parse of a `data` column

### Requirement: Anchor read and write functions

The system SHALL provide `getAnchor(id)`, `listAnchors()`, `insertAnchor(anchor)`, `updateAnchorCachedPath(id, cachedPath)`, `touchAnchor(id)`, and `deleteAnchor(id)`, all returning `Result<…, DbError>`. `touchAnchor` SHALL update `last_seen` only (the sighting heartbeat), never `updated_at`; `updateAnchorCachedPath` SHALL update `cached_path` and bump `updated_at`.

#### Scenario: Insert then read back an anchor

- **WHEN** `insertAnchor(anchor)` succeeds and `getAnchor(anchor.id)` is called
- **THEN** it returns `ok` with the same `Anchor` fields
- **AND** `getAnchor` of an unknown id returns `ok(null)`

#### Scenario: Touch is a heartbeat, not a data edit

- **WHEN** `touchAnchor(id)` is called
- **THEN** the row's `last_seen` advances and `updated_at` is unchanged

#### Scenario: Delete an anchor

- **WHEN** `deleteAnchor(id)` is called
- **THEN** a subsequent `getAnchor(id)` returns `ok(null)`

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

### Requirement: Resolve an id-or-name reference in one query

The system SHALL provide `findAnalysesByRef(ref: IdOrName)` and `findProjectByRef(ref: IdOrName)`, each resolving in a SINGLE id-priority query — never fetch-by-id-then-by-name. `findAnalysesByRef` SHALL return the candidate set ordered `(id = $ref) DESC, created_at DESC` so an exact id sorts first and the caller can detect a name/slug collision (more than one row, none by id). `findProjectByRef` SHALL return the single best match (`projects.name` is `UNIQUE`).

#### Scenario: Exact id wins over name

- **WHEN** `findAnalysesByRef(ref)` is called and `ref` is an exact analysis id
- **THEN** that analysis sorts first in the returned candidates

#### Scenario: Ambiguous name surfaces as multiple candidates

- **WHEN** `ref` matches several analyses by name/slug and none by id
- **THEN** the result has more than one row and the caller treats it as ambiguous

#### Scenario: Project resolved by id or unique name

- **WHEN** `findProjectByRef(ref)` is called
- **THEN** it returns the single project whose `id` or `name` equals `ref`, or `null`

### Requirement: Project create helper mints ids inline

The system SHALL provide `createProject({ name, description, tags })`, minting `id = randomUUIDv7()` and timestamps inline and persisting the row. `createProject` SHALL rely on the `projects.name` `UNIQUE` constraint, surfacing a duplicate as a `constraint_violation` (`unique`) for the caller to translate.

#### Scenario: Duplicate project name trips the constraint

- **WHEN** `createProject` is called with a name that already exists
- **THEN** it returns a `constraint_violation` error of constraint `unique` (no second row is created)

### Requirement: Entity insert functions do not mint ids

`insertAnchor`, `insertAnalysis`, and `insertAnalysisInput` SHALL persist the fully-formed entity passed by the caller and return it, minting no ids in this layer (the caller mints inline with `randomUUIDv7()`).

#### Scenario: Insert persists the caller-supplied id

- **WHEN** `insertAnalysis(analysis)` is called
- **THEN** the row's id equals `analysis.id` (no new id is generated in this layer)

### Requirement: Analysis inputs mapped to four columns

The system SHALL provide `listAnalysisInputs(analysisId)` and `insertAnalysisInput(input)`, mapping the four `analysis_inputs` columns directly to/from `AnalysisInput`, encoding `isDir` as the `is_dir` INTEGER (`0/1`). There SHALL be no `deleteAnalysisInputs`; input rows are removed by the `ON DELETE CASCADE` from their analysis.

#### Scenario: Insert and read back an input row

- **WHEN** `insertAnalysisInput({ path, isDir: true, analysisId, anchorId })` succeeds
- **THEN** `listAnalysisInputs(analysisId)` returns a row whose `isDir` is `true` (decoded from `is_dir = 1`)
- **AND** an input with `anchorId: null` round-trips with `anchorId` null and an absolute `path`

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

### Requirement: Bulk helpers for recovery

The system MUST give `deleteAnalysesForAnchor(anchorId)`, which `prune` uses. It MUST return the count of the deleted rows, and the input refs cascade. The system MUST also give `relocateRawInputPrefix(fromPrefix, toPrefix)`. It MUST rewrite each input path with `anchor_id IS NULL` under a moved tree, on true path boundaries, and return the count that it rewrote.

The system MUST NOT keep a count query for each project or for each anchor. The paged project read gives the count of each project in its own statement. The prune lists the analyses of the dead anchors in one read.

#### Scenario: Raw input prefix rewrite respects path boundaries

- **WHEN** `relocateRawInputPrefix("/a/b", "/a/c")` runs
- **THEN** a raw input at `/a/b/x` becomes `/a/c/x` and a sibling `/a/bc` stays as it is

#### Scenario: A prune deletes the analyses of a dead anchor

- **GIVEN** a dead anchor that homes two analyses
- **WHEN** `deleteAnalysesForAnchor(anchorId)` runs
- **THEN** it returns 2, and the input rows of the two analyses go with them

### Requirement: Seen mark and analysis name functions

The system MUST give these functions, each returning `Result<…, DbError>`:

- `recordRunSeen(runId, analysisId, atMs)`: one `INSERT` of a seen mark that keeps an existing mark. It MUST return the rows-changed count: `1` for a new mark, and `0` when the run has a mark. A second call MUST keep the first `seen_at`.
- `getRunSeenState()`: the `since` of the seen baseline, or `null` when no baseline row exists, and the run id of each seen mark. It sends two statements: one for the baseline and one for the marks.
- `listAnalysisNames(ids)`: the name of each analysis of the list that has a row, as a map from the id to the name, in one statement. An id with no row MUST have no entry. An empty list MUST give an empty map and send no query.

#### Scenario: A second mark keeps the first time

- **GIVEN** a seen mark of run `r1` at time T
- **WHEN** `recordRunSeen("r1", "a1", T + 1000)` runs
- **THEN** it returns 0, and the `seen_at` of the mark stays T

#### Scenario: The seen state

- **GIVEN** the baseline row and marks of runs `r1` and `r2`
- **WHEN** `getRunSeenState()` runs
- **THEN** it returns the `since` of the baseline and the ids `r1` and `r2`

#### Scenario: The names of a list

- **GIVEN** analyses `a1` named `trial` and `a2` named `bulk`
- **WHEN** `listAnalysisNames(["a1", "a2", "gone"])` runs
- **THEN** it returns `a1` to `trial` and `a2` to `bulk`, with no entry for `gone`, from one statement
