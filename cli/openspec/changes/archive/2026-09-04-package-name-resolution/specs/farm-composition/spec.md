## MODIFIED Requirements

### Requirement: Extension walks the graph and refuses ambiguity

A farm MUST extend only through the graph: the request resolves against the
`by_name` ordering, and `closureOf` walks the resolved edges as a lookup,
never a resolution. A dangling edge and an unknown root MUST refuse. The
pass MUST plan against an overlay first and write second. A version
collision of one distribution MUST refuse the whole batch, with the farm
unchanged.

The resolution reads the Python shelf under the PEP 503 fold of the
request, and the R shelf under the request verbatim. A request that names
an ecosystem MUST read that shelf only. A request that names none MUST
resolve by this ladder, in this order:

1. The R shelf holds the request, and the request differs from its own
   fold: the R directory. An uppercase letter or a dot comes only from an
   R spelling.
2. The R shelf holds the request, and the Python shelf holds the fold:
   the resolution stops as ambiguous, with the two head directories.
3. The R shelf holds the request: the R directory. An R name that is its
   own fold, such as `dplyr`, reaches its package here.
4. The Python shelf holds the fold: the Python directory.
5. Exactly one R key folds to the fold of the request: unknown, with that
   key as the suggestion.
6. Otherwise: unknown.

A silent Python-first pick is a fault. The behavior of an ambiguous stop
splits by route. An interactive command asks the user. The seam route
returns an ambiguity refusal with the two candidates as agent guidance,
because a backgrounded run has no user. The detail names the track of each
candidate, because the two directory names can differ only in the version.

#### Scenario: The both-hit ask reaches the user

- **GIVEN** a pool that holds `igraph` in the Python track and the R track
- **WHEN** a link request names `igraph` with no ecosystem
- **THEN** the user gets an ask that names the two candidates, and no link lands before the answer

#### Scenario: A collision leaves the farm unchanged

- **GIVEN** a farm that links one version of a distribution, and a batch that brings another version
- **WHEN** the extension runs
- **THEN** the batch refuses with the two versions named, and the farm stays as it was

#### Scenario: An exact R spelling wins over a folded Python hit

- **GIVEN** a pool that holds `decoupler` in the Python track and `decoupleR` in the R track
- **WHEN** a link request names `decoupleR` with no ecosystem
- **THEN** the resolution gives the R directory, and no ask appears

#### Scenario: A folded Python spelling wins over a folded R hit

- **GIVEN** a pool that holds `decoupler` in the Python track and `decoupleR` in the R track
- **WHEN** a link request names `decoupler` with no ecosystem
- **THEN** the resolution gives the Python directory, and no ask appears

#### Scenario: A same-spelling pair stops as ambiguous

- **GIVEN** a pool that holds `igraph` in both tracks
- **WHEN** the seam route resolves `igraph` with no ecosystem
- **THEN** the outcome is a collision whose detail names the Python directory and the R directory by track

#### Scenario: An R name that is its own fold resolves

- **GIVEN** a pool that holds `dplyr` in the R track and no `dplyr` in the Python track
- **WHEN** a link request names `dplyr` with no ecosystem
- **THEN** the resolution gives the R directory

#### Scenario: A folded R spelling is a suggestion

- **GIVEN** a pool that holds `Seurat` in the R track and no `seurat` in the Python track
- **WHEN** a link request names `seurat`
- **THEN** the resolution is unknown, and the suggestion reads `Seurat`

#### Scenario: A qualified request reads one shelf

- **GIVEN** a pool that holds `igraph` in both tracks
- **WHEN** a link request names `igraph` with the ecosystem `r`
- **THEN** the resolution gives the R directory

### Requirement: The canonical name is a lookup identity only

The lookup identity of a distribution MUST obey the rule of its track. The
canonical name (the PEP 503 form) MUST serve as the identity of a Python
distribution: the flight keys, the pool inventory, the graph names, and the
request resolution. The DESCRIPTION spelling MUST serve as the identity of
an R package in the pool inventory, the graph names, and the request
resolution. The flight key of an R acquisition keeps the canonical form,
because the flight carries its ecosystem and the fold cannot cross a track
there. Neither identity MUST serve as an installer ref, and neither MUST
replace a raw spelling on a user surface. A Python installer accepts the
canonical form, because PEP 503 defines the equivalence. An R installer
does not, thus the boundary is a requirement and not a style.

#### Scenario: The canonical form never reaches an installer

- **GIVEN** a request whose raw spelling is `GO.db`
- **WHEN** the acquisition builds the installer ref
- **THEN** the ref carries `GO.db`, and the canonical form stays in the keys

#### Scenario: The seam echoes the requested spelling

- **GIVEN** a `link_packages` request for `GO.db` that the pool does not hold
- **WHEN** the seam reports the outcome
- **THEN** the outcome names `GO.db`, thus a remedy built from it stays installable

#### Scenario: The pool inventory shows the exact R spelling

- **GIVEN** a pool whose R track holds `decoupleR`
- **WHEN** the pool inventory renders the R section
- **THEN** the row reads `decoupleR`, never `decoupler`

#### Scenario: A Python spelling folds at the lookup

- **GIVEN** a pool whose Python track holds `pyyaml`
- **WHEN** a link request names `PyYAML`
- **THEN** the lookup resolves the same pool directory

## ADDED Requirements

### Requirement: The host reads one graph version

The graph reader MUST accept graph version 2 only. A graph of another
version MUST refuse as `graph_unusable`, and the refusal MUST name the two
versions. When the version on disk is lower, the refusal MUST name
`inflexa store download --update` as the remedy. When the version on disk
is higher, the refusal MUST name a host upgrade as the remedy. The reason:
a version-1 graph keys the R track in lower case, and a version-2 reader
that reads it misses every R package with no other sign.

The commit of an acquisition reads the same two shelves, thus it MUST also
refuse a graph of another version. Its refusal names the same two remedies,
and no staged node lands.

#### Scenario: An old store refuses with the update remedy

- **GIVEN** a store whose `deps.json` carries version 1
- **WHEN** the reader opens it
- **THEN** the refusal names version 1, version 2, and `inflexa store download --update`

#### Scenario: A newer store refuses with the upgrade remedy

- **GIVEN** a store whose `deps.json` carries version 3
- **WHEN** the reader opens it
- **THEN** the refusal names version 3, version 2, and a host upgrade

#### Scenario: The commit of an acquisition refuses an old store

- **GIVEN** a store whose `deps.json` carries version 1
- **WHEN** the commit of an acquisition opens it
- **THEN** the commit refuses with the update remedy, and no staged node lands
