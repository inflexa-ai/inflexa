# reference-data-catalog Specification

## Purpose

Define the canonical host-neutral reference-data catalog, deterministic install
plans, and shared receipt metadata consumed by every harness embedder.

## Requirements

### Requirement: The harness publishes the canonical reference-data catalog

The harness SHALL ship a checked-in, versioned catalog of reference datasets through its public package surface. Each dataset SHALL have a stable id, version, title, description, source URL, license URL or license identifier, recommendation/group metadata, and at least one artifact. Each artifact SHALL have the `https` URL of the third party that publishes it, a safe dataset-relative destination path, and an integrity class.

Catalog validation SHALL reject duplicate dataset ids, duplicate artifact destinations within a dataset, absolute or traversal-bearing destinations, non-`https` artifact URLs, non-SHA-256 digests, and non-positive artifact sizes.

#### Scenario: An embedder lists supported references

- **WHEN** an embedder reads the exported catalog
- **THEN** it receives the same validated dataset ids, versions, upstream URLs, source and licensing links, and integrity classes as every other embedder using that harness version

#### Scenario: An unsafe catalog path is rejected

- **WHEN** a catalog artifact destination is absolute or contains a `..` traversal segment
- **THEN** catalog validation fails before an embedder can construct an install plan

### Requirement: Reference artifacts are fetched from the upstream that publishes them

Each artifact SHALL name the official third-party URL it is fetched from, and the project SHALL NOT mirror, re-host, or redistribute reference bytes. No embedder-configurable distribution endpoint SHALL exist, because a configurable source is a source that can be substituted: the catalog's provenance and licensing claims are only true of the upstream it names.

#### Scenario: There is no endpoint to configure

- **WHEN** an embedder installs a catalog dataset
- **THEN** it fetches every artifact from the upstream URL in the catalog, and no configuration can redirect that fetch to another origin

#### Scenario: CLI and managed select the same datasets

- **WHEN** the CLI and managed embedder resolve the same catalog ids from the same harness version
- **THEN** both receive content-identical plans naming the same upstream URLs

### Requirement: An artifact's integrity class states what its upstream can actually guarantee

Every artifact SHALL declare an integrity class, and that class SHALL reflect a property of the upstream rather than a preference of ours. A `pinned` artifact — one whose upstream publishes immutable, versioned bytes — SHALL carry a byte size and SHA-256 digest. An `unpinned` artifact — one whose upstream regenerates the same URL in place, so that no checked-in digest could survive — SHALL carry neither, because a digest that is guaranteed to go stale is worse than an absent one: it promises verification and delivers a broken download.

#### Scenario: Immutable upstream is pinned

- **WHEN** an upstream publishes a dated or release-versioned file that never changes
- **THEN** its artifact is `pinned` with a size and SHA-256, and an install that receives different bytes fails without activating anything

#### Scenario: Mutable upstream is not pretended to be pinned

- **WHEN** an upstream rebuilds a file in place at a stable URL (NCBI regenerating `gene_info`, Reactome overwriting `current`)
- **THEN** its artifact is `unpinned`, the catalog states no digest, and the weaker guarantee is surfaced to the user rather than hidden

### Requirement: Catalog artifacts describe final immutable files

Every artifact in the initial catalog format SHALL describe one final file to stage beneath its dataset installation root. The catalog SHALL NOT contain executable installer scripts, arbitrary shell commands, or untyped transformation recipes, and SHALL NOT describe a derived file that no upstream serves — a locally-converted artifact cannot be fetched from its publisher, and its digest attests only to the machine that produced it.

#### Scenario: A multi-file reference is fully described

- **WHEN** a dataset requires two companion files
- **THEN** its install plan contains two artifact entries, each with its own upstream URL, destination, and integrity class

#### Scenario: A stable identity survives a moved URL

- **WHEN** an embedder keys a resumable partial transfer off an artifact
- **THEN** it uses the artifact's catalog identity (`<dataset-id>/<version>/<path>`), not its URL, so a changed upstream URL does not orphan in-flight state

### Requirement: Reference installation receipts record what was actually received

The harness SHALL define a versioned receipt contract containing the dataset id and version, activation timestamp, and for each installed artifact its relative path, integrity class, and the byte size and SHA-256 digest **observed at install time**. A receipt SHALL be optional metadata: its absence or invalidity SHALL NOT mean the corresponding files are unavailable.

Observed digests SHALL NOT be copied from the catalog. For a `pinned` artifact the observed digest necessarily equals the catalog's, since activation fails otherwise; for an `unpinned` artifact the receipt is the only record of what the mutable upstream served, and is therefore what later verification compares against.

#### Scenario: Different embedders describe the same installation

- **WHEN** local and managed installers activate the same install plan
- **THEN** each can emit a receipt that validates against the same harness-owned contract

#### Scenario: An unpinned install is still verifiable afterwards

- **WHEN** an `unpinned` artifact is installed and its bytes are later altered on disk
- **THEN** verification against the receipt reports the file as modified, even though the catalog never carried a digest for it

#### Scenario: Invalid receipt does not hide files

- **WHEN** discovery encounters an invalid or stale receipt beside readable reference files
- **THEN** it reports the filesystem content without receipt enrichment rather than treating the store as unavailable

### Requirement: The harness does not provision reference bytes

The catalog module SHALL perform no network transfer, credential resolution, host-directory creation, archive extraction, PVC management, or user prompting. Those behaviors SHALL remain the responsibility of embedder adapters.

#### Scenario: Catalog planning is side-effect free

- **WHEN** an install plan is resolved
- **THEN** no filesystem or network state changes and no deployment-specific configuration is required
