## ADDED Requirements

### Requirement: Migration runner is tested
The suite SHALL verify the SQLite migration runner against a fresh database: all tables and foreign
keys are created, `PRAGMA foreign_keys` is on, the `_migrations` ledger records applied migrations,
and a second `runMigrations` call is a no-op (idempotent).

#### Scenario: migrations create the schema and are idempotent
- **WHEN** `runMigrations(new Database(":memory:"), migrations)` runs once, then again
- **THEN** the schema exists after the first run and the second run applies nothing new

### Requirement: Query and mutation round-trips are tested
The suite SHALL verify representative `db/` query+mutation pairs against a temp DB: a value written
by a mutation is read back by the corresponding query, and `DbError` constraint classification is
correct for unique-violation, foreign-key, and not-null failures.

#### Scenario: write then read
- **WHEN** a mutation inserts a row and the matching query reads it
- **THEN** the read returns the written values

#### Scenario: constraint violations are classified
- **WHEN** an insert violates a unique / FK / not-null constraint
- **THEN** the returned `DbError` carries the correct classification (not a generic error)

### Requirement: id-or-name resolvers are tested
The suite SHALL verify `findProjectByRef`/`findAnalysesByRef` resolve id-first in a single query
with correct ambiguity ordering, and `matchAnalysis` reshapes a colliding name into
`{ analysis, others }`.

#### Scenario: id beats name
- **WHEN** a ref matches one row by id and a different row by name
- **THEN** the id match is returned first

#### Scenario: ambiguous name surfaces collisions
- **WHEN** two analyses share a name and neither matches by id
- **THEN** `matchAnalysis` returns the first plus the colliding `others`

### Requirement: Marker read/write is tested
The suite SHALL verify `readMarker`/`writeMarker`/`findMarkerUpwards` against temp dirs:
absence vs corruption are distinguished, the marker is write-once, and the schema rejects a wrong
`schemaVersion` or missing `anchorId`.

#### Scenario: corruption is distinct from absence
- **WHEN** `readMarker` runs on a missing file vs a malformed file
- **THEN** the two cases return distinguishable results (not both "absent")

#### Scenario: write-once
- **WHEN** `writeMarker` is called for a path that already has a marker
- **THEN** the existing marker is preserved (not overwritten)

### Requirement: Anchor reconciliation is tested
The suite SHALL verify `resolveAnchor` across its reconciliation paths (cached-hit, self-heal when
the cached path moved, bounded upward search with unique-vs-ambiguous outcomes) and
`classifyMarkerSighting` (copy / move / ok), using temp directories.

#### Scenario: self-heal after a move
- **WHEN** the cached path no longer holds the marker but an ancestor does
- **THEN** `resolveAnchor` finds it and updates the cached path

#### Scenario: ambiguous sighting is reported
- **WHEN** the bounded search finds the marker id in more than one location
- **THEN** the result reports ambiguity rather than silently picking one

### Requirement: Path and config file resolution are tested
The suite SHALL verify `classifyInputPath` (anchor-relative vs absolute, `..` escape guard),
`resolveOutputDir` (its 3-case ladder), and `readConfig`/`writeConfig` round-trip including
malformed-JSON fail-closed, against temp dirs.

#### Scenario: path escape is rejected
- **WHEN** `classifyInputPath` receives a `..` path that escapes the anchor
- **THEN** it is rejected/flagged, not resolved outside the boundary

#### Scenario: malformed config fails closed
- **WHEN** `readConfig` reads a malformed JSON config file
- **THEN** it returns a safe default / typed failure rather than throwing
