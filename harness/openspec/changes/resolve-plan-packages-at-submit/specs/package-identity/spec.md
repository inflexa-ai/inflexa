## ADDED Requirements

### Requirement: Two pool indexes join into one index

The harness MUST export `joinPoolIndexes(first, second)` from
`harness/src/sandbox/package-identity.ts`. The joined `has` MUST answer true
when one of the two indexes holds the identity. The joined
`rIdentitiesFoldingTo` MUST answer each identity of the two indexes that folds
to the fold, one time for each identity key.

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

### Requirement: A package resolves over the pool first, then over the image

The harness MUST export `imageBaseOf(record)`, `EMPTY_IMAGE_BASE`, and
`resolvePackage(query, sources)`. An image base holds the R identity of each
`r_base` name and the Python identity of each `python_stdlib` name. It also
holds the runtime version of each track. `EMPTY_IMAGE_BASE` holds no identity.

`resolvePackage` MUST resolve in two steps:

1. Resolve the query over the pool index. A `resolved` answer is the answer,
   with the source `pool`.
2. Otherwise, resolve the query over the pool index joined with the image
   index. A `resolved` answer has the source `image` and the runtime version.

Thus a spelling that the pool resolves keeps that answer, although the image
holds the spelling in the other track. When the source is `image` and the
query pins a version that is not the runtime version, the answer MUST be
`image_version`. A pin of a pool package MUST NOT take part.

The plan validation and the link pass of an embedder MUST both call this
function. Thus the two readers give one answer for each entry.

#### Scenario: A pool name keeps its answer beside an image name of the other track

- **GIVEN** a pool that holds `r:optparse`, and an image base that holds `python:optparse`
- **WHEN** `resolvePackage({ spelling: "optparse" }, sources)` runs
- **THEN** it answers `pool` with `r:optparse`

#### Scenario: A base package resolves from the image

- **GIVEN** an image base that holds `r:stats` at the R runtime `4.6.0`, and a pool that does not hold it
- **WHEN** `resolvePackage({ spelling: "stats", track: "r" }, sources)` runs
- **THEN** it answers `image` with `r:stats` and the version `4.6.0`

#### Scenario: A wrong pin of a base package is a version answer

- **GIVEN** an image base that holds `r:stats` at the R runtime `4.6.0`
- **WHEN** `resolvePackage({ spelling: "stats", track: "r", version: "3.0.0" }, sources)` runs
- **THEN** it answers `image_version`, and the held version is `4.6.0`

#### Scenario: A both-track name of the pool stays ambiguous

- **GIVEN** a pool that holds `python:igraph` and `r:igraph`
- **WHEN** `resolvePackage({ spelling: "igraph" }, sources)` runs
- **THEN** it answers `ambiguous` with `python:igraph` and `r:igraph`

#### Scenario: A record from before the base sets holds nothing

- **GIVEN** a record with no `r_base` and no `python_stdlib`
- **WHEN** `resolvePackage({ spelling: "stats" }, sources)` runs over an empty pool
- **THEN** it answers `unknown`
