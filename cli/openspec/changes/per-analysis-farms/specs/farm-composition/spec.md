# farm-composition Specification

## ADDED Requirements

### Requirement: A farm is composed per analysis from the pool

The CLI MUST compose the farm of an analysis on the host, with no container. Composition MUST read the resolved dependency graph `deps.json` at the store root. It MUST take the closure of the requested roots and link that closure from the pool into `farms/<analysisId>`.

Composition MUST make the three link shapes the provisioner makes: the top-level entry links with namespace-directory promotion, the R inner-directory links, and the relative bin hoist. It MUST write the farm markers — `packages.txt`, `meta.json`, and `lock.json` — in the shared inventory shape, so the harness usability gate accepts the farm.

Composition MUST NOT resolve a version constraint. The graph carries resolved edges, thus the walk is a lookup. A root that the graph does not hold MUST be a named error, not a network call.

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

### Requirement: A farm is made with its analysis, and it starts empty

The CLI MUST make `farms/<analysisId>` when it makes the analysis. The farm MUST start empty, and it MUST carry its markers only. A farm is a tree of links and a few small records, thus an empty one costs almost nothing on disk.

The farm MUST exist before the planner runs. The planner names the packages that a plan wants, and it cannot name them into a farm that does not exist. Thus a composition at the first sandbox action would arrive too late.

A composition MUST NOT invent a package set. It links what a caller names, and it links nothing else. No declaration of packages MUST live in the store, in an agent, or in this specification.

A root that the graph does not hold MUST be a named error. A named root MUST take its closure, because a caller that names a package asks for what that package needs.

#### Scenario: The farm is made with the analysis

- **WHEN** an analysis is made
- **THEN** `farms/<analysisId>` exists, it holds its markers, and it links no package

#### Scenario: A chat-only analysis keeps an empty farm

- **GIVEN** an analysis in which the user only chats
- **WHEN** no plan and no sandbox action runs
- **THEN** the farm stays empty, and it costs the markers alone

#### Scenario: A farm holds what it was told to hold

- **GIVEN** a catalog that holds many packages and an analysis whose plan named two of them
- **WHEN** composition links them
- **THEN** the farm holds those two and their closure, and it holds nothing else

#### Scenario: An unknown root is a named error

- **GIVEN** a root that the graph does not hold
- **WHEN** composition runs
- **THEN** it fails with the name of the root, and it makes no partial farm

### Requirement: The packages of a farm come from the plan and from the steps

The planner MUST give the set of packages that its plan wants. For each package of that set, the CLI MUST do one of two things. When the pool holds it, the CLI MUST link it into the farm. When the pool does not hold it, the CLI MUST ask the user to install it, before the run starts.

A step MUST reach a package that the planner did not name, through the tool of the harness seam. Thus one package that a plan missed does not fail a whole run.

The graph gives no edge for a requirement under an extra, because the emitter evaluates a marker with no extra active. Thus a closure walk can miss such a distribution, and the import of it fails inside the sandbox. That failure MUST be recoverable through the same tool, and it MUST NOT be silent.

#### Scenario: A planned package that the pool holds is linked

- **GIVEN** a plan that names a package which the pool holds
- **WHEN** the CLI reads the plan
- **THEN** it links that package and its closure into the farm, and it asks the user for nothing

#### Scenario: A planned package that the pool lacks asks the user

- **GIVEN** a plan that names a package which the pool does not hold
- **WHEN** the CLI reads the plan
- **THEN** it asks the user to install it, and the run waits on that answer

#### Scenario: A step reaches what the plan missed

- **GIVEN** a live sandbox whose farm lacks a package that the pool holds
- **WHEN** the step requests it
- **THEN** the farm links it, and the next import inside that same sandbox resolves it

### Requirement: A farm extends additively and safely under a live sandbox

An extension MUST add links for new closure members and MUST NOT touch an existing link. Thus a live sandbox of the farm keeps every resolution it made, and the next import inside the same sandbox resolves the new links.

A per-farm mutex MUST serialize two compositions of one farm, because namespace-directory promotion re-writes a link as a directory. Compositions of two different farms MUST run concurrently.

A version collision MUST refuse with names. When a new link and an existing link share a top-level name but not a store directory, the extension fails. The failure MUST name the two store directories, and the farm MUST stay as it was.

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

Composition MUST link the prepared cache directories of the catalog template farm — the numba cache and the matplotlib configuration — into each analysis farm. It MUST NOT copy them. A cache entry that does not match the package version of a farm misses and recompiles, which is safe.

The template farm is thus the one home of a prepared cache. An acquisition MUST warm into that same home, thus one warm serves each farm that links the package. A cache for each farm would compile one package again for each analysis that adds it.

#### Scenario: The caches are shared by link

- **WHEN** composition makes a farm
- **THEN** the cache directories of the farm are links into the catalog template farm, and no cache file is copied

#### Scenario: One warm serves each farm

- **GIVEN** two analyses that link a package which an acquisition warmed
- **WHEN** each runs the workload of that package
- **THEN** both load the prepared entries, and neither compiles them again

### Requirement: The composed layout stays in parity with the provisioner layout

A golden-fixture test MUST pin the TypeScript composer against the provisioner's farm builder: one fixture pool, composed by both, compared tree for tree. A divergence MUST fail CI with a path diff.

#### Scenario: A layout divergence fails CI

- **GIVEN** the fixture pool
- **WHEN** the two implementations compose it and the trees differ
- **THEN** the test fails and reports the differing paths

### Requirement: A farm dies with its analysis

`analysis delete` MUST remove `farms/<analysisId>` after the lease check: a removal refuses while a lease records a live sandbox of the farm. Reclaim MUST gain a reaper pass that removes a farm whose analysis id no longer exists in the DB. The reaper MUST run only inside the reclaim command, because reclamation is never implicit.

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

### Requirement: Composition waits on a reclamation and takes no provisioner lock

Composition MUST NOT take the store lock of the provisioner. It runs on the host
at the first sandbox action of an analysis. A lock there would put a
container-scoped wait on that path.

Composition MUST yield while a live process holds the host reclamation lock. A
farm holds the closure of its roots, thus a walk can reach a store directory that
no farm links yet. A reclamation between the walk and the link would remove that
directory, and the farm would then hold a link that resolves to nothing.

A reclamation MUST wait for each live composition before it deletes, exactly as
it waits for each live acquisition flight. Thus the two never interleave, and
neither one starves the other.

A composition MUST record its liveness where a reclamation reads it. A record
that a dead process left MUST NOT block a reclamation. The liveness of the holder
is the signal, and the record alone is not.

#### Scenario: A composition yields to a live reclamation

- **GIVEN** a reclamation that holds the lock
- **WHEN** a first sandbox action starts a composition
- **THEN** the composition waits, and it links nothing until the reclamation finishes

#### Scenario: A reclamation waits for a live composition

- **GIVEN** a composition that walks the graph
- **WHEN** a reclamation starts
- **THEN** it waits for that composition to finish before it deletes a store directory

#### Scenario: A dead composition blocks nothing

- **GIVEN** a liveness record whose process is gone
- **WHEN** a reclamation starts
- **THEN** it sweeps that record and proceeds
