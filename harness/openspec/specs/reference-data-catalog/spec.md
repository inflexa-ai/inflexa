# reference-data-catalog Specification

## Purpose

Define the canonical host-neutral reference-data catalog, deterministic install
plans, and shared receipt metadata consumed by every harness embedder.

## Requirements

### Requirement: The harness publishes the canonical reference-data catalog

The harness SHALL ship a checked-in, versioned catalog of reference datasets through its public package surface. Each dataset SHALL have a stable id, version, title, description, source URL, license URL or license identifier, recommendation/group metadata, and at least one artifact. Each artifact SHALL have an opaque distribution key, byte size, SHA-256 digest, and a safe dataset-relative destination path.

Catalog validation SHALL reject duplicate dataset ids, duplicate artifact destinations within a dataset, absolute or traversal-bearing destinations, non-SHA-256 digests, and non-positive artifact sizes.

#### Scenario: An embedder lists supported references

- **WHEN** an embedder reads the exported catalog
- **THEN** it receives the same validated dataset ids, versions, source and licensing links, and content identities as every other embedder using that harness version

#### Scenario: An unsafe catalog path is rejected

- **WHEN** a catalog artifact destination is absolute or contains a `..` traversal segment
- **THEN** catalog validation fails before an embedder can construct an install plan

### Requirement: Reference selection resolves to a host-neutral install plan

The harness SHALL expose a pure selection operation that accepts requested dataset ids and returns either a typed unknown-id error or a deterministic install plan. The plan SHALL contain the selected dataset metadata and final-file artifacts with distribution keys, hashes, sizes, and dataset-relative destinations. It SHALL NOT contain host storage roots, credentials, terminal behavior, PVC configuration, or a required concrete download URL.

#### Scenario: CLI and managed select the same datasets

- **WHEN** the CLI and managed embedder resolve the same catalog ids from the same harness version
- **THEN** both receive content-identical plans even if they map artifact keys to different distribution endpoints

#### Scenario: Unknown selection is explicit

- **WHEN** a requested id is absent from the catalog
- **THEN** selection returns a typed error naming the unknown id and available ids, without producing a partial plan

### Requirement: Catalog artifacts describe final immutable files

Every artifact in the initial catalog format SHALL describe one final file to stage beneath its dataset installation root. The catalog SHALL NOT contain executable installer scripts, arbitrary shell commands, or untyped transformation recipes. A dataset with multiple files SHALL list each file as a separately hashed artifact.

#### Scenario: A multi-file reference is fully content-addressed

- **WHEN** a dataset requires two companion files
- **THEN** its install plan contains two artifact entries, each with its own distribution key, destination, size, and SHA-256 digest

### Requirement: Reference installation receipts have a shared versioned shape

The harness SHALL define a versioned receipt contract containing the dataset id and version, activation timestamp, and the installed artifacts' relative paths, sizes, and SHA-256 digests. A receipt SHALL be optional metadata: its absence or invalidity SHALL NOT mean the corresponding files are unavailable.

#### Scenario: Different embedders describe the same installation

- **WHEN** local and managed installers activate the same install plan
- **THEN** each can emit a receipt that validates against the same harness-owned contract

#### Scenario: Invalid receipt does not hide files

- **WHEN** discovery encounters an invalid or stale receipt beside readable reference files
- **THEN** it reports the filesystem content without receipt enrichment rather than treating the store as unavailable

### Requirement: The harness does not provision reference bytes

The catalog module SHALL perform no network transfer, credential resolution, host-directory creation, archive extraction, PVC management, or user prompting. Those behaviors SHALL remain the responsibility of embedder adapters.

#### Scenario: Catalog planning is side-effect free

- **WHEN** an install plan is resolved
- **THEN** no filesystem or network state changes and no deployment-specific configuration is required
