## ADDED Requirements

### Requirement: Two pool indexes join into one index

The harness MUST export `joinPoolIndexes(first, second)` from
`harness/src/sandbox/package-identity.ts`. The joined `has` MUST answer true
when one of the two indexes holds the identity. The joined
`rIdentitiesFoldingTo` MUST answer each identity of the two indexes that folds
to the fold, one time for each identity key. Thus `resolveQuery` runs one time
over the joined index. A spelling that the two indexes both hold obeys the same
ladder as a spelling of one index.

#### Scenario: The joined index holds the identities of both

- **GIVEN** an index that holds `python:scanpy`, and an index that holds `r:stats`
- **WHEN** the two indexes join
- **THEN** the joined index holds `python:scanpy` and `r:stats`

#### Scenario: One identity in two indexes suggests one time

- **GIVEN** two indexes that both hold `r:Seurat`
- **WHEN** `resolveQuery({ spelling: "seurat" }, joined)` runs
- **THEN** it answers `unknown` with the suggestion `r:Seurat`

#### Scenario: A spelling in two tracks of two indexes is ambiguous

- **GIVEN** an index that holds `python:grid`, and an index that holds `r:grid`
- **WHEN** `resolveQuery({ spelling: "grid" }, joined)` runs
- **THEN** it answers `ambiguous` with `python:grid` and `r:grid`

### Requirement: The image record gives a pool index

The harness MUST export `imagePoolIndex(record)`. The index MUST hold the R
identity of each `r_base` name of the record. It MUST hold the Python identity
of each `python_stdlib` name. A record that carries neither field MUST give an
index that holds nothing. The census index of the planner MUST join this index
to its pool index. The link pass of an embedder MUST do the same. Thus the two
readers give one answer for a base package.

#### Scenario: A base R package resolves

- **GIVEN** a record whose `r_base` holds `stats`
- **WHEN** `resolveQuery({ spelling: "stats", track: "r" }, imagePoolIndex(record))` runs
- **THEN** it answers `resolved` with `r:stats`

#### Scenario: A standard-library module resolves

- **GIVEN** a record whose `python_stdlib` holds `json`
- **WHEN** `resolveQuery({ spelling: "json" }, imagePoolIndex(record))` runs
- **THEN** it answers `resolved` with `python:json`

#### Scenario: A record from before the fields holds nothing

- **GIVEN** a record with no `r_base` and no `python_stdlib`
- **WHEN** `resolveQuery({ spelling: "stats" }, imagePoolIndex(record))` runs
- **THEN** it answers `unknown`
