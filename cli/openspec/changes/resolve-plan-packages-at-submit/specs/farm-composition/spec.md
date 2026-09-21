## MODIFIED Requirements

### Requirement: Extension walks the graph and refuses ambiguity

A farm MUST extend only through the graph: a request for a pool package
resolves against the `by_name` ordering, and `closureOf` walks the resolved
edges as a lookup, never a resolution. A dangling edge and an unknown root MUST
refuse. The pass MUST plan against an overlay first and write second. A version
collision of one distribution MUST refuse the whole batch, with the farm
unchanged.

`store link` and `store add` MUST resolve through `resolveQuery` of the harness
`package-identity` capability. The host supplies a `PoolIndex` over the graph.
`has` reads the shelf of the track of the identity under its name.
`rIdentitiesFoldingTo` scans the R shelf for the identities whose address
equals the fold. The cli MUST hold no ladder of its own. After a `resolved`
answer, the host picks the version: the head of the shelf when the query names
none, the exact match when it names one, and `unknown_version` otherwise.

The seam route MUST resolve through `resolvePackage` of the harness, over the
pool index of the graph and the image base of the store. Thus the seam route
and the plan validation give one answer for each entry. The rule resolves over
the pool first, then over the pool and the image. A spelling that the pool
resolves keeps that answer, although the image holds it in the other track.

An `image` answer MUST be `present`, with the runtime version of its track, and
the seam MUST link nothing for it. An `image_version` answer MUST refuse with
`unknown_version`. The seam route MUST read the image record at the root of the
store one time for the batch, and it MUST build the two indexes one time. An
absent record MUST give the empty image base. A record that does not parse MUST
answer `unavailable` for each query, with the path of the record, and never an
absence.

An `ambiguous` answer stops, and a silent Python-first pick is a fault.
The behavior of the stop splits by route. An interactive command asks the
user. The seam route returns a collision whose detail carries the two
identity keys, because a backgrounded run has no user. The collision carries
two claims. A claim is the head store directory of the pool, or the runtime of
the image for a track that only the image holds. The claim is total: an
ambiguous identity that neither source holds is a broken rule, and not a
refusal.

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

#### Scenario: A base R package is present

- **GIVEN** a store whose record holds `stats` in `r_base` and the R runtime `4.6.0`
- **WHEN** the seam receives a query with the spelling `stats` and the track `r`
- **THEN** the outcome is `present` with the version `4.6.0`, and the farm links nothing

#### Scenario: A standard-library module is present

- **GIVEN** a store whose record holds `json` in `python_stdlib`
- **WHEN** the seam receives a query with the spelling `json`
- **THEN** the outcome is `present`

#### Scenario: A pin of a version that the runtime does not hold refuses

- **GIVEN** a store whose record holds `stats` in `r_base` and the R runtime `4.6.0`
- **WHEN** the seam receives a query with the spelling `stats`, the track `r`, and the version `3.0.0`
- **THEN** the outcome is `absent`

#### Scenario: A pool spelling keeps its answer beside an image name of the other track

- **GIVEN** a store whose Python track holds `beta`, and whose record holds `beta` in `r_base`
- **WHEN** the seam receives a query with the spelling `beta` and no track
- **THEN** the outcome is `linked`

#### Scenario: A spelling that only the image holds in two tracks collides

- **GIVEN** a store whose record holds `zeta` in `r_base` and in `python_stdlib`, and a pool that does not hold it
- **WHEN** the seam receives a query with the spelling `zeta` and no track
- **THEN** the outcome is a `collision` whose claims name the two runtimes of the image, and whose detail names `python:zeta` and `r:zeta`

#### Scenario: A damaged record answers unavailable

- **GIVEN** a store whose image record does not parse
- **WHEN** the seam receives a query
- **THEN** the outcome is `unavailable`, its reason names the record, and no outcome is `absent`

#### Scenario: A store with no record keeps the answer of the graph

- **GIVEN** a store with no image record
- **WHEN** the seam receives a query with the spelling `stats` and the track `r`
- **THEN** the outcome is `absent`
