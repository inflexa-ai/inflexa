# Delta: package-store-management

## ADDED Requirements

### Requirement: Analysis creation makes the empty farm

Analysis creation MUST make the farm of the analysis, empty, with its
`inflexa.lock`, before the profile trigger. Thus every post-release analysis
carries a farm from birth, and no sandbox races the discriminator. The empty
lock holds the schema, the arch, and an empty package list. A failed farm
make MUST stop the creation. The message MUST name the farm path, the
cause, and the retry — a farm-less analysis would be a broken shell.

#### Scenario: A new analysis has a farm before its first sandbox

- **WHEN** an analysis is created
- **THEN** its farm exists with an empty lock, before the profile workflow starts

#### Scenario: A farm-make failure stops the creation

- **GIVEN** a farm path that cannot be written
- **WHEN** the analysis creation runs
- **THEN** the creation stops, and the message names the farm path, the cause, and the retry

#### Scenario: The profiler of a new analysis meets the empty farm

- **GIVEN** a freshly created analysis
- **WHEN** the profile sandbox resolves its farm
- **THEN** the resolver finds the farm, and the full-composition path does not run

### Requirement: A farm-less analysis heals full from the catalog

When no farm exists for an analysis, the heal MUST compose a full farm from
the closure of the catalog farm, through the staging swap. The missing farm
is the pre-release discriminator, thus the heal never runs for a
post-release analysis. The heal runs at the first of three triggers:

- an analysis open with the catalog present
- the catalog landing, observed by the transfer poll of the open session
- the farm resolution of a sandbox, as the backstop

The healed farm MUST copy the catalog `inflexa.lock` verbatim. Thus the
advertised inventory equals the linked content, and the warm records ride.
With no catalog and no live transfer, the open MUST prompt for the
download, with one consent. Between the consent and the landing, the
analysis stays farm-less, and a launch refuses with the classified
live-transfer reason. A present farm MUST stay untouched.

#### Scenario: A pre-release analysis keeps everything available

- **GIVEN** an analysis created before the release, with no farm, and a present catalog
- **WHEN** the analysis opens
- **THEN** the farm links the whole catalog closure, and the lock is the catalog copy

#### Scenario: A live transfer defers the heal to the landing

- **GIVEN** a farm-less analysis open while the catalog transfer runs
- **WHEN** the transfer poll observes the landing
- **THEN** the heal runs, and the next sandbox serves the full farm without a restart

#### Scenario: No catalog prompts for the download

- **GIVEN** a farm-less analysis, no catalog, and no live transfer
- **WHEN** the analysis opens
- **THEN** the open prompts for the download, and a launch before the landing refuses with the classified reason

#### Scenario: A present farm stays as it is

- **GIVEN** an analysis whose farm exists, empty or composed
- **WHEN** any trigger fires
- **THEN** the farm is served unchanged, and no composition runs

#### Scenario: A concurrent heal serializes

- **GIVEN** two triggers that fire for one analysis at the same time
- **WHEN** the two heals run
- **THEN** they serialize under the store lock, and the second serves the published farm

#### Scenario: A hand-deleted farm heals full

- **GIVEN** an analysis whose farm directory was removed outside the product
- **WHEN** a trigger fires
- **THEN** the analysis heals full, as a safe degradation
