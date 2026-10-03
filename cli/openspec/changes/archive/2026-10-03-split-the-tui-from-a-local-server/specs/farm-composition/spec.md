## REMOVED Requirements

### Requirement: Extension walks the graph and refuses ambiguity

**Reason**: The scenario "The both-hit ask reaches the user" is false. `store link` is a client of the local server, and no route asks the user. A MODIFIED block cannot drop a scenario, thus the requirement comes again under a new name.
**Migration**: Refer to "Extension walks the graph and refuses an ambiguous request". It keeps each other rule and scenario, and a both-hit link refuses with the `--lang` remedy.

## ADDED Requirements

### Requirement: Extension walks the graph and refuses an ambiguous request

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

An `ambiguous` answer stops, and a silent Python-first pick is a fault. No
route asks the user. `store link` is a client of the local server, and the
server has no terminal for a question. Thus the link MUST refuse the whole
request, with the two candidates and the `--lang` remedy, and it MUST link
nothing. The seam route returns a collision whose detail carries the two
identity keys, because a backgrounded run has no user.

#### Scenario: A both-hit link refuses with the --lang remedy

- **GIVEN** a pool that holds `igraph` in the Python track and the R track
- **WHEN** a query with the spelling `igraph` and no track reaches `store link`
- **THEN** the link refuses, the message names the two candidates and `--lang python` or `--lang r`, and no link lands

#### Scenario: A collision leaves the farm unchanged

- **GIVEN** a farm that links one version of a distribution, and a batch that brings another version
- **WHEN** the extension runs
- **THEN** the batch refuses with the two versions named, and the farm stays as it was

#### Scenario: The host resolves through the harness

- **GIVEN** a pool that holds `decoupler` in the Python track and `decoupleR` in the R track
- **WHEN** a query with the spelling `decoupleR` and no track resolves
- **THEN** the resolution gives the R directory, through `resolveQuery`, and no refusal appears

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

## MODIFIED Requirements

### Requirement: A farm dies with its analysis behind a hardened gate

The analysis delete flow MUST remove the farm of the analysis. The delete
runs in the local server, behind the busy gate of the server. The gate
MUST hold while live work runs: a chat turn, a queued or running profile,
or a durable run.

The gate MUST read the liveness of a run from the
durable status of its workflow, not from the run row. Thus a stale
`running` row whose workflow is terminal does not block the delete. A
ledger or a status table that the gate cannot read MUST block. The
reclaim MUST reap a farm whose analysis the database no longer holds.

#### Scenario: A stale running row does not block

- **GIVEN** an analysis with a `running` run row whose host died, and whose workflow is terminal
- **WHEN** the user deletes the analysis
- **THEN** the gate reads the run as not live, and the delete proceeds with the farm removal

#### Scenario: A live run blocks the delete

- **GIVEN** an analysis with a run whose workflow is live
- **WHEN** the user deletes the analysis
- **THEN** the server refuses the delete as busy, and the farm stays
