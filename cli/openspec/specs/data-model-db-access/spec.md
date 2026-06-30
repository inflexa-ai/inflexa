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

The system SHALL provide `listAnalyses()`, `listAnalysesByAnchor(anchorId)`, `listAnalysesByProject(projectId)`, `insertAnalysis(analysis)`, `updateAnalysis(analysis)`, and `updateAnalysisProject(id, projectId|null)`, all returning `Result<…, DbError>`. The three list functions SHALL order by `created_at` descending. There SHALL be no `archiveAnalysis` (no archive feature) and no `getAnalysis` (id lookups go through the id-or-name resolver).

#### Scenario: Insert then list an analysis

- **WHEN** `insertAnalysis(analysis)` succeeds
- **THEN** the row's columns equal the entity's fields and it appears in `listAnalyses()`

#### Scenario: List by anchor and project, newest first

- **WHEN** analyses exist under anchor A and project P
- **THEN** `listAnalysesByAnchor(A)` returns those homed at A and `listAnalysesByProject(P)` those grouped under P, each ordered by `created_at` descending

#### Scenario: Targeted project update signals not-found

- **WHEN** `updateAnalysisProject(id, projectId)` runs
- **THEN** it issues one `UPDATE … SET project_id = ?, updated_at = ? WHERE id = ?` and returns the rows-changed count (`0` when no such analysis exists)

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

### Requirement: Project and session create helpers mint ids inline

The system SHALL provide `createProject({ name, description, tags })` and `createSession({ title?, analysisId })`, each minting `id = randomUUIDv7()` and timestamps inline and persisting the row. `createProject` SHALL rely on the `projects.name` `UNIQUE` constraint, surfacing a duplicate as a `constraint_violation` (`unique`) for the caller to translate. `createSession` SHALL write `analysisId` into the `sessions.analysis_id` column, leaving the `Session` JSON unchanged.

#### Scenario: Duplicate project name trips the constraint

- **WHEN** `createProject` is called with a name that already exists
- **THEN** it returns a `constraint_violation` error of constraint `unique` (no second row is created)

#### Scenario: Session carries its analysis id in the column

- **WHEN** `createSession({ analysisId })` succeeds
- **THEN** the row's `analysis_id` column equals `analysisId` and `listSessionsByAnalysis(analysisId)` returns it

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

### Requirement: Count and bulk helpers for grouping and recovery

The system SHALL provide `countAnalysesByProject(projectId)` and `countAnalysesByAnchor(anchorId)` (each `0` when none or the parent does not exist), `deleteAnalysesForAnchor(anchorId)` (used by `prune`, returning rows deleted; input refs cascade), and `relocateRawInputPrefix(fromPrefix, toPrefix)` (rewriting `anchor_id IS NULL` input paths under a moved tree, on true path boundaries, returning the count rewritten).

#### Scenario: Counts back the list views

- **WHEN** a project groups two analyses
- **THEN** `countAnalysesByProject(projectId)` returns `2`

#### Scenario: Raw input prefix rewrite respects path boundaries

- **WHEN** `relocateRawInputPrefix("/a/b", "/a/c")` runs
- **THEN** a raw input at `/a/b/x` becomes `/a/c/x` and a sibling `/a/bc` is left untouched

### Requirement: Analysis-scoped session reads

The system SHALL provide `listSessionsByAnalysis(analysisId)` returning `Result<Session[], DbError>`, selecting sessions `WHERE analysis_id = ?`. The `Session` type SHALL remain unchanged (the link lives in the column, not the JSON).

#### Scenario: Sessions filtered by analysis

- **WHEN** sessions are linked to an analysis via the `analysis_id` column
- **THEN** `listSessionsByAnalysis(analysisId)` returns exactly those sessions

