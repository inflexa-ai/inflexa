# reference-data-catalog Specification

## Purpose

Define the canonical host-neutral reference-data catalog, deterministic install
plans, and shared receipt metadata consumed by every harness embedder.

## Requirements

### Requirement: The harness publishes the canonical reference-data catalog

The harness SHALL ship a checked-in, versioned catalog of reference datasets through its public package surface. Each dataset SHALL have a stable id, version, title, description, source URL, license URL or license identifier, recommendation/group metadata, and at least one artifact. Each artifact SHALL have exactly the `https` URL of the third party that publishes it and a safe dataset-relative destination path — no size, digest, or integrity class.

Catalog validation SHALL reject duplicate dataset ids, duplicate artifact destinations within a dataset, absolute or traversal-bearing destinations, non-`https` artifact URLs, and any stray size or digest field offered on an artifact.

#### Scenario: An embedder lists supported references

- **WHEN** an embedder reads the exported catalog
- **THEN** it receives the same validated dataset ids, versions, upstream URLs, and source and licensing links as every other embedder using that harness version

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

### Requirement: Reference integrity is uniform trust-on-first-use

The catalog SHALL carry no per-artifact size or digest, and there SHALL be no integrity class. Every artifact is authenticated over TLS at download time, and the bytes actually received are recorded in the install receipt so later verification can prove the local copy has not changed since install. A checked-in digest is deliberately not maintained: it would apply unevenly — only upstreams that publish immutable bytes could ever carry one — and would put on this project the burden of computing and re-syncing a value that a `current` upstream immediately makes stale. TLS authenticates the publisher, and the receipt catches post-install drift; the marginal supply-chain benefit of a reviewed digest does not justify that inconsistency and burden for public, re-downloadable reference data.

#### Scenario: The catalog names a source, not a checksum

- **WHEN** a dataset is added to the catalog
- **THEN** its artifact carries only an `https` URL and destination path — no size, digest, or integrity class — and adding a source requires no downloaded-and-hashed value

#### Scenario: Integrity is recovered from the receipt, not the catalog

- **WHEN** an installed file is later altered on disk
- **THEN** verification against the size and digest the receipt recorded at install reports it modified, even though the catalog never carried a digest

### Requirement: Catalog artifacts describe final immutable files

Every artifact in the initial catalog format SHALL describe one final file to stage beneath its dataset installation root. The catalog SHALL NOT contain executable installer scripts, arbitrary shell commands, or untyped transformation recipes, and SHALL NOT describe a derived file that no upstream serves — a locally-converted artifact cannot be fetched from its publisher and carries no third-party provenance.

#### Scenario: A multi-file reference is fully described

- **WHEN** a dataset requires two companion files
- **THEN** its install plan contains two artifact entries, each with its own upstream URL and destination

#### Scenario: A stable identity survives a moved URL

- **WHEN** an embedder keys a resumable partial transfer off an artifact
- **THEN** it uses the artifact's catalog identity (`<dataset-id>/<version>/<path>`), not its URL, so a changed upstream URL does not orphan in-flight state

### Requirement: Reference installation receipts record what was actually received

The harness SHALL define a versioned receipt contract containing the dataset id and version, activation timestamp, and for each installed artifact its relative path and the byte size and SHA-256 digest **observed at install time**. A receipt SHALL be optional metadata: its absence or invalidity SHALL NOT mean the corresponding files are unavailable. A receipt written by an older build MAY carry a now-removed integrity field; parsing SHALL ignore it rather than reject the receipt.

Observed digests SHALL NOT be copied from the catalog, which carries none: the receipt is the sole record of what the upstream served at install time, and is therefore what later verification compares the files against.

#### Scenario: Different embedders describe the same installation

- **WHEN** local and managed installers activate the same install plan
- **THEN** each can emit a receipt that validates against the same harness-owned contract

#### Scenario: An install is still verifiable afterwards

- **WHEN** an installed artifact's bytes are later altered on disk
- **THEN** verification against the receipt reports the file as modified, even though the catalog never carried a digest for it

#### Scenario: Invalid receipt does not hide files

- **WHEN** discovery encounters an invalid or stale receipt beside readable reference files
- **THEN** it reports the filesystem content without receipt enrichment rather than treating the store as unavailable

### Requirement: The harness does not provision reference bytes

The catalog module SHALL perform no network transfer, credential resolution, host-directory creation, archive extraction, PVC management, or user prompting. Those behaviors SHALL remain the responsibility of embedder adapters.

#### Scenario: Catalog planning is side-effect free

- **WHEN** an install plan is resolved
- **THEN** no filesystem or network state changes and no deployment-specific configuration is required
