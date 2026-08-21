# farm-composition Specification

## Purpose

The per-analysis farms of the package store on the host. A farm is made with its analysis, extends through the dependency graph, carries the warm cache, and dies with its analysis.

## Requirements

### Requirement: A farm is made empty with its analysis

The CLI MUST make the farm of an analysis when it makes the analysis, and
the new farm is empty: the link trees and one `inflexa.lock`, with no
package. A farm failure MUST NOT fail the analysis creation. The farm
provider of the composition root MUST heal a missing farm at the first
sandbox action, as an empty farm.

#### Scenario: The farm rides the analysis creation

- **WHEN** `analysis new` completes
- **THEN** `farms/<analysisId>` exists with an empty `inflexa.lock`

#### Scenario: A deleted farm heals empty

- **GIVEN** an analysis whose farm directory a user deleted
- **WHEN** the next sandbox action resolves the farm
- **THEN** the provider makes an empty farm and the sandbox mounts it

### Requirement: Extension walks the graph and refuses ambiguity

A farm MUST extend only through the graph: the request resolves against the
`by_name` ordering, and `closureOf` walks the resolved edges as a lookup,
never a resolution. A dangling edge and an unknown root MUST refuse. When the
request names no ecosystem and both tracks hold the name, the extension
MUST stop. The behavior splits by route. An interactive command asks the
user. The seam route returns an ambiguity refusal with the two candidates
as agent guidance, because a backgrounded run has no user. A silent
Python-first pick is a fault. The pass MUST plan against an overlay first
and write second. A version collision of one distribution MUST refuse the
whole batch, with the farm unchanged.

#### Scenario: The both-hit ask reaches the user

- **GIVEN** a pool that holds `igraph` in the Python track and the R track
- **WHEN** a link request names `igraph` with no ecosystem
- **THEN** the user gets an ask that names the two candidates, and no link lands before the answer

#### Scenario: A collision leaves the farm unchanged

- **GIVEN** a farm that links one version of a distribution, and a batch that brings another version
- **WHEN** the extension runs
- **THEN** the batch refuses with the two versions named, and the farm stays as it was

### Requirement: Farms compose concurrently under per-farm mutexes

Each farm composition MUST hold the mutex `farm-<analysisId>`, thus two
farms compose at the same time and callers of one farm serialize. No lease
exists. The reclamation MUST enumerate the live compositions through the
lock holds, and it MUST wait or refuse instead of racing them.

#### Scenario: Two analyses compose at once

- **GIVEN** two analyses that link packages at the same time
- **WHEN** the two compositions run
- **THEN** both proceed, each under its own farm key

### Requirement: A farm dies with its analysis behind a hardened gate

The analysis delete flow MUST remove the farm of the analysis. The delete
gate MUST hold while live work runs: a streaming chat turn, a queued or
running profile, or a durable run. The gate MUST read liveness from the
lock holds, thus a stale `running` row with a dead holder does not block
the delete. The reclaim MUST reap a farm whose analysis the database no
longer holds.

#### Scenario: A stale running row does not block

- **GIVEN** an analysis with a `running` run row whose process died
- **WHEN** the user deletes the analysis
- **THEN** the gate reads the dead holder as not live, and the delete proceeds with the farm removal

### Requirement: The per-analysis warm cache seeds at farm creation

When the CLI makes a farm, it MUST seed the per-analysis cache directory
from the prepared caches of the catalog. The sandbox mounts that cache
read-write, thus a warm entry that an analysis writes persists between its
runs. A missing cache MUST degrade, never refuse. The cache MUST be per analysis. A loaded numba entry executes machine
code, and a shared writable home would let one analysis plant code for
another.

#### Scenario: The cache seeds from the catalog

- **WHEN** a farm is made for a new analysis
- **THEN** its cache directory holds a copy of the prepared catalog caches

#### Scenario: A warm entry persists between runs

- **GIVEN** a first run that compiled a numba kernel into the analysis cache
- **WHEN** a second run of the same analysis executes the same kernel
- **THEN** the kernel loads from the cache, with no second compile
