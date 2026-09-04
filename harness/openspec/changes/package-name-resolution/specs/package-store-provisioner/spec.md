## MODIFIED Requirements

### Requirement: The graph is exact and gated

The provisioner MUST publish `deps.json` at the store root with a
temp-file-plus-rename write. The graph version is 2. A node is one store
directory. A node carries the track, the name, the version, the imports,
the entry points, the edges, and `r_dir` for R. The name of a node MUST
obey the identity rule of its track: the PEP 503 form for a Python
distribution, and the DESCRIPTION spelling for an R package. A `by_name`
ordering lists the directories of each name, newest first, under that same
name. Thus the R track keys `decoupleR`, the Python track keys
`decoupler`, and the two tracks never share a key by the fold alone. The
store directory name keeps the PEP 503 form for both tracks, because the
directory is an address and not an identity. Python edges come from the
distribution metadata, with markers evaluated through `packaging` and
`extra=""`. An unparseable marker keeps the edge. R edges come from
`Depends` and `Imports` only. `LinkingTo` records as build metadata and
gives no edge. An edge that names no node MUST stop the run, unless the
image-owned list holds the name.

The gate MUST also stop the run when the name of an R node differs from
its `r_dir`, because that difference is the fold fault. The gate MUST
report each name that the Python track and the R track hold in one
spelling. A plan must qualify such a name, thus the planner must see the
list. The report is a log line, and the run continues.

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
- **THEN** the node name is `decoupleR`, `by_name.r` holds the key `decoupleR`, and no key of `by_name.r` reads `decoupler`

#### Scenario: A Python node keeps the PEP 503 form

- **GIVEN** a Python distribution whose metadata name is `Decoupler`
- **WHEN** its node is emitted
- **THEN** the node name is `decoupler`, and `by_name.python` holds the key `decoupler`

#### Scenario: The version stripped from a directory name uses the folded form

- **GIVEN** an R store directory `go-db-3.21.0-<hash>` whose inner directory is `GO.db`
- **WHEN** its node is emitted
- **THEN** the node version is `3.21.0`, and the node name is `GO.db`

#### Scenario: A folded R name stops the build

- **GIVEN** an R node whose name reads `decoupler` and whose `r_dir` reads `decoupleR`
- **WHEN** the gate runs
- **THEN** the run fails and names the node

#### Scenario: A same-spelling both-track name is reported

- **GIVEN** a Python node `igraph` and an R node `igraph`
- **WHEN** the gate runs
- **THEN** the build log names `igraph` as a both-track name, and the run continues

#### Scenario: The graph carries version 2

- **WHEN** the graph publishes
- **THEN** `version` reads 2
