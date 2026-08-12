# farm-composition Specification

## ADDED Requirements

### Requirement: A farm is composed per analysis from the pool

The CLI SHALL compose the farm of an analysis on the host, with no container. Composition SHALL read the resolved dependency graph `deps.json` at the store root. It SHALL take the closure of the requested roots and link that closure from the pool into `farms/<analysisId>`.

Composition SHALL make the three link shapes the provisioner makes: the top-level entry links with namespace-directory promotion, the R inner-directory links, and the relative bin hoist. It SHALL write the farm markers — `packages.txt`, `meta.json`, and `lock.json` — in the shared inventory shape, so the harness usability gate accepts the farm.

Composition SHALL NOT resolve a version constraint. The graph carries resolved edges, thus the walk is a lookup. A root that the graph does not hold SHALL be a named error, not a network call.

#### Scenario: A composed farm passes the usability gate

- **WHEN** composition completes for an analysis
- **THEN** the farm resolves at `farms/<analysisId>` with `packages.txt` and `meta.json`, and the next sandbox of the analysis mounts it

#### Scenario: The closure comes from the graph

- **GIVEN** a graph in which scanpy names anndata and numpy
- **WHEN** composition runs with scanpy as a root
- **THEN** the farm links scanpy, anndata, and numpy, and it links nothing outside the closure

#### Scenario: An unknown root is a named error

- **GIVEN** a root that the graph does not hold
- **WHEN** composition runs
- **THEN** it fails with the root's name, makes no partial farm, and opens no network call

#### Scenario: Composition starts no container

- **WHEN** composition runs
- **THEN** no container starts, and no network call opens

### Requirement: Composition is lazy and the default closure is the template

The first sandbox action of an analysis SHALL trigger composition, through the farm provider. An analysis that starts no sandbox SHALL get no farm.

The default roots of a new farm SHALL be the requested set of the catalog template farm, read from its `lock.json`. Thus the first sandbox of a new analysis resolves the same set the single active farm served before this change.

#### Scenario: The first sandbox composes the farm

- **GIVEN** an analysis with no farm
- **WHEN** its first sandbox action runs
- **THEN** composition makes `farms/<analysisId>` before the sandbox is created, and the sandbox mounts it

#### Scenario: A chat-only analysis makes no farm

- **GIVEN** an analysis in which the user only chats
- **WHEN** no sandbox action runs
- **THEN** no farm exists for the analysis

#### Scenario: The default closure matches the template

- **GIVEN** a fresh analysis and a catalog template farm
- **WHEN** the first composition runs with no explicit roots
- **THEN** the farm's lock records the template's requested set

### Requirement: A farm extends additively and safely under a live sandbox

An extension SHALL add links for new closure members and SHALL NOT touch an existing link. Thus a live sandbox of the farm keeps every resolution it made, and the next import inside the same sandbox resolves the new links.

A per-farm mutex SHALL serialize two compositions of one farm, because namespace-directory promotion re-writes a link as a directory. Compositions of two different farms SHALL run concurrently.

A version collision SHALL refuse with names. When a new link and an existing link share a top-level name but not a store directory, the extension fails. The failure SHALL name the two store directories, and the farm SHALL stay as it was.

#### Scenario: An extension reaches a live sandbox

- **GIVEN** a live sandbox whose farm lacks a package
- **WHEN** an extension links that package
- **THEN** the next import of it inside the same sandbox succeeds, and every earlier import stays valid

#### Scenario: Two extensions of one farm serialize

- **WHEN** two extensions of one farm run at the same time
- **THEN** one waits on the per-farm mutex, and the final farm holds the links of both

#### Scenario: A version collision refuses with names

- **GIVEN** a farm that links pandas from one store directory
- **WHEN** an extension would link pandas from a different store directory
- **THEN** the extension refuses, names the two store directories, and changes nothing

### Requirement: The warm caches link from the catalog template

Composition SHALL link the prepared cache directories of the catalog template farm — the numba cache and the matplotlib configuration — into each analysis farm. It SHALL NOT copy them. A cache entry that does not match a farm's package version misses and recompiles, which is safe.

#### Scenario: The caches are shared by link

- **WHEN** composition makes a farm
- **THEN** the farm's cache directories are links into the catalog template farm, and no cache file is copied

### Requirement: The composed layout stays in parity with the provisioner layout

A golden-fixture test SHALL pin the TypeScript composer against the provisioner's farm builder: one fixture pool, composed by both, compared tree for tree. A divergence SHALL fail CI with a path diff.

#### Scenario: A layout divergence fails CI

- **GIVEN** the fixture pool
- **WHEN** the two implementations compose it and the trees differ
- **THEN** the test fails and reports the differing paths

### Requirement: A farm dies with its analysis

`analysis delete` SHALL remove `farms/<analysisId>` after the lease check: a removal refuses while a lease records a live sandbox of the farm. Reclaim SHALL gain a reaper pass that removes a farm whose analysis id no longer exists in the DB. The reaper SHALL run only inside the reclaim command, because reclamation is never implicit.

#### Scenario: Deleting the analysis removes the farm

- **GIVEN** an analysis with a farm and no live sandbox
- **WHEN** `analysis delete` runs
- **THEN** the farm is removed, and the pool is untouched

#### Scenario: A live sandbox blocks the removal

- **GIVEN** a lease that records a live sandbox of the farm
- **WHEN** `analysis delete` runs
- **THEN** the farm removal refuses and names the sandbox, and the analysis rows are untouched

#### Scenario: The reaper removes an orphan farm

- **GIVEN** a farm whose analysis id is not in the DB
- **WHEN** reclamation runs
- **THEN** the reaper removes the farm, and reclamation then frees what no farm references
