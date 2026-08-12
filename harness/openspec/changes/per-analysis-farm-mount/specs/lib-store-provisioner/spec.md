# lib-store-provisioner Delta — Per-Analysis Farm Mount

## MODIFIED Requirements

### Requirement: Provisioning does not disturb a sandbox that is already running

Provisioning SHALL take effect for sandboxes created after it, and SHALL NOT attempt to change what a running sandbox sees. The store SHALL NOT carry an active-farm pointer, thus no run swings one. A run that extends a farm SHALL only add links, because an added link changes no path a running sandbox already resolved.

A farm removal SHALL refuse while a lease records that a sandbox of that farm holds the store mounted. The lease keeps this one job. No lease SHALL block an acquisition run or a farm extension.

#### Scenario: A live farm extends without disturbance

- **GIVEN** a sandbox with the store mounted and its farm at `/mnt/libs/current`
- **WHEN** a run adds links to that farm
- **THEN** every path the sandbox resolved before the run still resolves the same content

#### Scenario: A farm removal refuses under a lease

- **GIVEN** a lease that records a live sandbox of a farm
- **WHEN** a removal of that farm is requested
- **THEN** the removal refuses, and reports that a sandbox is using the farm

#### Scenario: The next sandbox sees the new package

- **GIVEN** a package provisioned into an analysis's farm
- **WHEN** the next sandbox of that analysis is created
- **THEN** the package is importable and listed in the inventory

## ADDED Requirements

### Requirement: Acquisition runs are parallel and commit under a mutex

Concurrent acquisition runs SHALL be permitted, because content addressing makes the pool writes race-safe. Two runs that produce the same distribution SHALL converge on one store directory. A run SHALL NOT hold an exclusive whole-store lock for its length.

The shared metadata — the dependency graph and the store-level inventory — SHALL update inside one short mutex, taken at the commit of a run. Thus two commits serialize, and no reader sees a half-written record.

Reclaim SHALL be exclusive against every acquisition run: it waits for zero live runs and blocks new ones while it scans and deletes. A run that crashed before its commit leaves pool directories that no farm references and no graph names. Reclaim SHALL remove them.

#### Scenario: Two different packages provision at the same time

- **WHEN** two acquisition runs for two different packages run concurrently
- **THEN** both complete, and the pool holds the store directories of both

#### Scenario: Two identical results converge

- **WHEN** two concurrent runs produce the same distribution at the same version
- **THEN** the pool holds one store directory for it, and both runs report success

#### Scenario: Reclaim excludes live runs

- **GIVEN** an acquisition run that has written pool directories but has not committed
- **WHEN** reclaim is requested
- **THEN** reclaim waits for the run to finish, and it does not delete the directories of that run

#### Scenario: A crashed run leaves only reclaim food

- **GIVEN** a run that crashed after pool writes and before its commit
- **WHEN** the next reclaim runs
- **THEN** it removes the unreferenced directories, and the graph and the inventory are unchanged by the crash

### Requirement: The provisioner publishes a resolved dependency graph

The provisioner SHALL publish a dependency graph at the store root, as `deps.json`. The store-directory name of a distribution SHALL be the key of its node. A node SHALL carry the track, the import names, the entry points, and, for an R package, the inner-directory name. An edge SHALL name another node exactly. The graph SHALL NOT carry a version range, because every constraint resolves at build time.

Python edges come from the installed distribution metadata, with each environment marker evaluated in the build environment. The build environment is the sandbox environment, thus each marker evaluates to its runtime truth. R edges come from the `Depends`, `Imports`, and `LinkingTo` fields of each installed `DESCRIPTION`. An edge into an image-owned base package SHALL be dropped against a fixed list.

One emitter SHALL serve the CI catalog build and every acquisition run. An acquisition run SHALL append its nodes and edges under the commit mutex. The build SHALL fail when an edge names a node that the graph does not hold.

#### Scenario: The graph covers the catalog

- **WHEN** the CI catalog build completes
- **THEN** `deps.json` holds one node for each store directory, and every edge lands on a node

#### Scenario: An acquisition run appends its closure

- **GIVEN** a published graph
- **WHEN** an acquisition run adds a distribution with its dependencies
- **THEN** the graph gains the new nodes and edges, and every earlier node is unchanged

#### Scenario: A dangling edge fails the build

- **GIVEN** a resolved closure whose emitted edge names a missing node
- **WHEN** the CI gate runs
- **THEN** the build fails and names the edge

## REMOVED Requirements

### Requirement: The active pointer is not swung under a live sandbox

**Reason**: The store no longer carries an active-farm pointer. The farm of a sandbox arrives as a per-sandbox mount, thus no flip exists to refuse.
**Migration**: The refusal survives in one narrower form: a farm removal refuses under a live lease. See the modified requirement "Provisioning does not disturb a sandbox that is already running".
