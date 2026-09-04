## MODIFIED Requirements

### Requirement: Extension walks the graph and refuses ambiguity

A farm MUST extend only through the graph: the request resolves against the
`by_name` ordering, and `closureOf` walks the resolved edges as a lookup,
never a resolution. A dangling edge and an unknown root MUST refuse. The
pass MUST plan against an overlay first and write second. A version
collision of one distribution MUST refuse the whole batch, with the farm
unchanged.

The resolution MUST run through `resolveQuery` of the harness
`package-identity` capability. The host supplies a `PoolIndex` over the
graph. `has` reads the shelf of the track of the identity under its name.
`rIdentitiesFoldingTo` scans the R shelf for the identities whose address
equals the fold. The cli MUST hold no ladder of its own. After a
`resolved` answer, the host picks the version: the head of the shelf when
the query names none, the exact match when it names one, and
`unknown_version` otherwise.

An `ambiguous` answer stops, and a silent Python-first pick is a fault.
The behavior of the stop splits by route. An interactive command asks the
user. The seam route returns a collision whose detail carries the two
identity keys, because a backgrounded run has no user.

#### Scenario: The both-hit ask reaches the user

- **GIVEN** a pool that holds `igraph` in the Python track and the R track
- **WHEN** a query with the spelling `igraph` and no track reaches `store link`
- **THEN** the user gets an ask that names the two candidates, and no link lands before the answer

#### Scenario: A collision leaves the farm unchanged

- **GIVEN** a farm that links one version of a distribution, and a batch that brings another version
- **WHEN** the extension runs
- **THEN** the batch refuses with the two versions named, and the farm stays as it was

#### Scenario: The host resolves through the harness

- **GIVEN** a pool that holds `decoupler` in the Python track and `decoupleR` in the R track
- **WHEN** a query with the spelling `decoupleR` and no track resolves
- **THEN** the resolution gives the R directory, through `resolveQuery`, and no ask appears

#### Scenario: A same-spelling pair stops as ambiguous

- **GIVEN** a pool that holds `igraph` in both tracks
- **WHEN** the seam route resolves a query with the spelling `igraph` and no track
- **THEN** the outcome is a collision whose detail names `python:igraph` and `r:igraph`

#### Scenario: A folded R spelling is a suggestion

- **GIVEN** a pool that holds `Seurat` in the R track and no `seurat` in the Python track
- **WHEN** a query with the spelling `seurat` resolves
- **THEN** the resolution is unknown, and the suggestion is `r:Seurat`

#### Scenario: The host picks the version after the resolution

- **GIVEN** a pool whose Python shelf holds `numpy` at `2.1.0` and `1.26.4`
- **WHEN** a query with the spelling `numpy` and the version `1.26.4` resolves
- **THEN** the resolution gives the `1.26.4` directory, and a query with the version `1.0.0` gives `unknown_version`

### Requirement: The host reads one graph version

The graph reader MUST accept graph version 2 only, as the harness change
`package-identity` defines it. A node carries no `r_dir`, and the reader
MUST ignore that field when a development store still carries it. A graph
of another version MUST refuse as `graph_unusable`, and the refusal MUST
name the two versions. When the version on disk is lower, the refusal
MUST name `inflexa store download --update` as the remedy. When the
version on disk is higher, the refusal MUST name a host upgrade as the
remedy. The reason: a version-1 graph keys the R track in lower case, and
a version-2 reader that reads it misses every R package with no other
sign.

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

#### Scenario: A development store with r_dir reads

- **GIVEN** a version-2 graph whose R node still carries `r_dir`
- **WHEN** the reader opens it
- **THEN** the node reads with its name, and the reader reports no error

## REMOVED Requirements

### Requirement: The canonical name is a lookup identity only

**Reason**: the lookup key of a package is the `PackageIdentity` of the
harness. The canonical name is the address of an identity, not a key, and
the cli holds no copy of the fold.

**Migration**: the requirement "The identity is the lookup key" below.

## ADDED Requirements

### Requirement: The identity is the lookup key

The host MUST key every lookup of a package by the `PackageIdentity` of
the harness: the graph shelves, the pool inventory, the acquisition
commit, and the request resolution. The cli MUST hold no function that
folds a name, and the one import of the harness module names the rule.
The address of an identity, `identityAddress`, MUST serve as a directory
prefix only. The spelling of a query MUST reach every render and every
installer ref verbatim. The pool inventory MUST publish the identity name
of each package and the track of each section.

#### Scenario: The address never reaches an installer

- **GIVEN** a query whose spelling is `GO.db`
- **WHEN** the acquisition builds the installer ref
- **THEN** the ref carries `GO.db`, and `go-db` names only a directory

#### Scenario: The seam echoes the spelling

- **GIVEN** a `link_packages` query for `GO.db` that the pool does not hold
- **WHEN** the seam reports the outcome
- **THEN** the outcome carries the spelling `GO.db`

#### Scenario: The pool inventory shows the identity and the track

- **GIVEN** a pool whose R track holds `decoupleR`
- **WHEN** the pool inventory renders the R section
- **THEN** the row reads `decoupleR`, and the section carries the track `r`

#### Scenario: A Python spelling folds at the lookup

- **GIVEN** a pool whose Python track holds `pyyaml`
- **WHEN** a query with the spelling `PyYAML` resolves
- **THEN** the lookup gives the same pool directory

#### Scenario: No fold function exists in the cli

- **WHEN** the sources under `cli/src` are searched for the PEP 503 rule
- **THEN** only the import of the harness module names it
