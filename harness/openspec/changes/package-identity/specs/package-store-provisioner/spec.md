## MODIFIED Requirements

### Requirement: The pool is content-addressed and write-once

Each installed distribution MUST store once, in a directory named
`<address>-<version>-<hash16>`. The address is the address of the
identity of the package: the PEP 503 fold of the identity name, for both
tracks. A store directory MUST never change after its publish. An R
package MUST nest as `<dir>/<name>/`, where `<name>` is the identity
name, because R rebuilds its own path as libname plus name. The content
address MUST be a sha256 over the sorted tree: each relative path, the
file bytes, the executable bit, and each symlink target. The provisioner
markers and the derived warm artifacts (`__pycache__`, `.pyc`, `.nbi`,
`.nbc`) MUST stay out of the hash, because warm-up writes them after the
address is taken. The directory name carries the first 16 hex characters.
The store MUST carry no `current` pointer and no lease files.

#### Scenario: One copy serves many farms

- **GIVEN** two farms that link one package version
- **WHEN** the pool is inspected
- **THEN** one store directory holds the one copy

#### Scenario: No pointer at the store root

- **WHEN** the store root is listed after any run
- **THEN** no `current` entry and no `leases/` directory exists

#### Scenario: The address folds the R identity

- **GIVEN** the R package `GO.db` at version `3.21.0`
- **WHEN** the provisioner stores it
- **THEN** the directory is `go-db-3.21.0-<hash16>`, and the inner directory is `GO.db`

### Requirement: The graph is exact and gated

The provisioner MUST publish `deps.json` at the store root with a
temp-file-plus-rename write. The graph version is 2. A node is one store
directory. A node carries the track, the name, the version, the imports,
the entry points, and the edges. The name of a node MUST be the identity
name: `python_identity` of the METADATA `Name` for a Python distribution,
and `r_identity` of the DESCRIPTION `Package` for an R package. No other
field carries a name. A `by_name` ordering lists the directories of each
identity name, newest first, under the track of the identity. Thus the R
track keys `decoupleR`, the Python track keys `decoupler`, and the two
tracks never share a key by the fold alone. The store directory name
keeps the address, because the directory is an address and not an
identity.

Python edges come from the distribution metadata, with markers evaluated
through `packaging` and `extra=""`. An unparseable marker keeps the edge.
R edges come from `Depends` and `Imports` only. `LinkingTo` records as
build metadata and gives no edge. An edge MUST name a store directory. An
edge that names no node MUST stop the run, unless the image-owned list
holds the name.

The gate MUST report each name that the Python track and the R track hold
in one spelling. A plan must qualify such a name, thus the planner must
see the list. The report is a log line, and the run continues.

#### Scenario: A dangling edge stops the build

- **GIVEN** an installed package whose dependency resolves to no store directory and no image-owned name
- **WHEN** the graph publishes
- **THEN** the run fails and names the edge

#### Scenario: LinkingTo gives no edge

- **GIVEN** an R package with a `LinkingTo` entry
- **WHEN** its node is emitted
- **THEN** the entry is absent from the edges and present in the build metadata

#### Scenario: An R node keeps its DESCRIPTION spelling

- **GIVEN** a store directory `decoupler-2.17.0-<hash>` whose inner directory is `decoupleR`
- **WHEN** its node is emitted
- **THEN** the node name is `decoupleR`, `by_name.r` holds the key `decoupleR`, and the node carries no `r_dir`

#### Scenario: A Python node keeps the PEP 503 form

- **GIVEN** a Python distribution whose metadata name is `Decoupler`
- **WHEN** its node is emitted
- **THEN** the node name is `decoupler`, and `by_name.python` holds the key `decoupler`

#### Scenario: The version stripped from a directory name uses the address

- **GIVEN** an R store directory `go-db-3.21.0-<hash>` whose inner directory is `GO.db`
- **WHEN** its node is emitted
- **THEN** the node version is `3.21.0`, and the node name is `GO.db`

#### Scenario: A same-spelling both-track name is reported

- **GIVEN** a Python node `igraph` and an R node `igraph`
- **WHEN** the gate runs
- **THEN** the build log names `igraph` as a both-track name, and the run continues

#### Scenario: The graph carries version 2

- **WHEN** the graph publishes
- **THEN** `version` reads 2, and no node carries `r_dir`

### Requirement: An unqualified name that both ecosystems satisfy stops

An acquire spec MUST be a query in the one grammar, read by `parse_query`
of the twin module. A query MUST carry an explicit track, or none. With
none, the run MUST search both ecosystems, each in the spelling of the
query. The R presence probe matches a name exactly, thus an R hit means
that the spelling is the R identity. When both hold the name, the run MUST
stop with a both-hit outcome that names the two identities, and the host
asks the user. A silent Python-first win is a fault.

#### Scenario: A both-hit name asks instead of guessing

- **GIVEN** a request for a name that PyPI and CRAN both hold, with no track given
- **WHEN** the acquire run resolves it
- **THEN** the outcome is a both-hit refusal with the two identities, and nothing installs

#### Scenario: The candidates are identities

- **GIVEN** an unqualified request `igraph` that PyPI and CRAN both hold
- **WHEN** the acquire run reports the both-hit
- **THEN** the candidates are `python:igraph` and `r:igraph`

#### Scenario: A spec parses through the twin

- **WHEN** the acquire run receives the spec `r:GO.db==3.21.0`
- **THEN** the query has the spelling `GO.db`, the track `r`, and the version `3.21.0`
