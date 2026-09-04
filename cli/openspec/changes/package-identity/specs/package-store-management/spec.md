## MODIFIED Requirements

### Requirement: store add takes one package with explicit flags

`store add` MUST take exactly one argument per call, with `--version <v>`
(optional, latest otherwise), `--lang python|r` (optional), and
`--analysis <ref>` (optional, extends that farm after the commit). The
command MUST parse the argument with `parseQuery` of the harness. A
version inside the argument is the version of the query. The two flags
merge into the query. A prefix such as `r:name` MUST NOT appear at the
command surface: an argument that carries one refuses with the `--lang`
remedy. A flag and a value in the argument that disagree MUST refuse.
Without `--lang`, the flight searches both ecosystems, and a name that
both satisfy stops with an ask to the user.

#### Scenario: One package per call

- **WHEN** `inflexa store add scanpy numpy` runs
- **THEN** the command refuses with the one-package rule

#### Scenario: A both-hit name asks

- **GIVEN** a name that PyPI and CRAN both hold, and no `--lang`
- **WHEN** the add runs
- **THEN** the user gets an ask that names the two candidates, and nothing installs before the answer

#### Scenario: A pinned argument records its version

- **WHEN** `inflexa store add scanpy==1.11` runs
- **THEN** the pending row carries the spelling `scanpy` and the specifier `==1.11`

#### Scenario: A prefix at the command surface refuses

- **WHEN** `inflexa store add r:Seurat` runs
- **THEN** the command refuses, and the refusal names `--lang r`

### Requirement: The launch refusal classifies each missing package

A launch whose plan packages cannot link MUST refuse before the run
reserves anything — the harness link pass is that gate. The remedy text of
the refusal MUST classify each missing spelling against the host rows. A
row matches a miss by identity when both carry a track. It matches by
spelling when neither carries a track. A pair in which only one side
carries a track matches nothing, because the side that names no track
stands for both ecosystems. A match with a pending add or a live flight
reads as in flight, with "launch again when it lands". A match with a
failed row carries the recorded reason, with the retry and the delete
remedies. An unknown spelling carries the store-add ask. When the
resolution carries a suggestion, the remedy MUST name its spelling before
the store-add ask. The pool holds the package under that spelling. Thus
the agent replans from the true state, and no run is wasted on a package
that never landed.

A version collision MUST name the two store directories and the closure
members that pull each side. The dependent is the remedy surface: the fix
is to drop or re-pin a dependent, and a bare name makes the reader guess
it. A two-track collision MUST name the two identity keys, and the two
prefixed forms written with `formatQuery`. The prefix is the remedy, thus
the refusal names it. An unreadable dependency graph MUST refuse as one
store-level reason, never as a per-package absence. A false absence sends
the agent after packages the pool holds, and it hides the structural
fault.

#### Scenario: An in-flight package defers the launch with its state

- **GIVEN** a plan package whose flight still runs
- **WHEN** the launch refuses on the pool miss
- **THEN** the remedy names the package as in flight, and directs a later launch, not a second ask

#### Scenario: A failed package surfaces its recorded reason at launch

- **GIVEN** a plan package with a `failed` flight row
- **WHEN** the launch refuses on the pool miss
- **THEN** the remedy carries the recorded reason, with the retry and the delete remedies

#### Scenario: A collision names the dependents

- **GIVEN** a plan whose closure pulls two pins of one distribution
- **WHEN** the launch refuses on the collision
- **THEN** the refusal names both store directories, each with the closure members that pull it

#### Scenario: A broken graph refuses as itself

- **GIVEN** a dependency graph with a dangling edge
- **WHEN** the launch runs its link pass
- **THEN** the refusal carries the graph reason, and no package reads as absent

#### Scenario: A two-track collision names the prefixed forms

- **GIVEN** a plan that names `igraph` bare, against a pool that holds `igraph` in both tracks
- **WHEN** the launch refuses on the collision
- **THEN** the refusal names `python:igraph` and `r:igraph`

#### Scenario: A folded R spelling names its suggestion

- **GIVEN** a plan that names `seurat`, against a pool that holds `Seurat` in the R track only
- **WHEN** the launch refuses on the pool miss
- **THEN** the remedy names `Seurat` before the store-add ask

#### Scenario: A Python flight does not answer an R miss

- **GIVEN** a live flight with the track `python` and the spelling `seurat`, and a plan that names `r:Seurat`
- **WHEN** the launch refuses on the pool miss
- **THEN** the remedy is the store-add ask, and it does not read as in flight

## REMOVED Requirements

### Requirement: A request carries its raw spelling beside its identity

**Reason**: a request is a `PackageQuery`, and its spelling is the one
name that it holds. A folded name is not a field of a request.

**Migration**: the requirement "A request is a query, and the ledger keys
its spelling" below. Migration 10 fills `spelling` from `raw_name`.

## ADDED Requirements

### Requirement: A request is a query, and the ledger keys its spelling

A `store add` request MUST be a `PackageQuery` of the harness. The flight
id MUST be `<track or any>::<spelling>::<specifier>`. The two request
tables MUST hold `spelling`, `ecosystem`, and `specifier`, and no folded
name. Migration 10 MUST rebuild the two tables, and it MUST fill
`spelling` from `raw_name`, or from `name` when `raw_name` is null. The
dedupe of the pending set MUST compare the spelling, the specifier, and
the track. Two spellings of one fold are two rows, because they are two
queries. The spelling MUST reach the installer and every render: the
sidebar pipeline, `store ls`, the refusal messages, and the both-hit ask.
The provisioner spec MUST be `formatQuery` of the query. Without `--lang`,
each ecosystem MUST be probed in the spelling, thus the both-hit guard
stays armed for a name that both ecosystems hold.

#### Scenario: A dotted R name reaches pak unchanged

- **WHEN** `inflexa store add GO.db --lang r` flushes
- **THEN** the provisioner spec is `r:GO.db`

#### Scenario: Two equal queries make one flight

- **GIVEN** two pending rows for `GO.db` with the track `r`
- **WHEN** the flush claims the set
- **THEN** one flight runs

#### Scenario: Two spellings make two flights

- **GIVEN** a pending `GO.db` and a pending `go.db`, both with the track `r`
- **WHEN** the flush claims the set
- **THEN** two flights run, and the second refuses because no R package is named `go.db`

#### Scenario: The render shows the spelling

- **GIVEN** a failed flight for `GO.db`
- **WHEN** the sidebar or `store ls` renders the row
- **THEN** the row reads `GO.db`, never `go-db`

#### Scenario: The both-hit guard arms for a dotted name

- **GIVEN** a name that PyPI holds under the folded form and CRAN holds under the spelling
- **WHEN** the add runs without `--lang`
- **THEN** the run stops with the two candidates, and nothing installs silently

#### Scenario: Migration 10 keeps the spelling of a live row

- **GIVEN** a database at migration 9 with a live flight row whose `raw_name` is `GO.db` and whose `name` is `go-db`
- **WHEN** migration 10 runs
- **THEN** the row carries the spelling `GO.db`, and no `name` column exists
