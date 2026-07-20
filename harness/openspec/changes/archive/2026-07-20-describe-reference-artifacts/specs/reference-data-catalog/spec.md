# reference-data-catalog — delta

## MODIFIED Requirements

### Requirement: The harness publishes the canonical reference-data catalog

The harness SHALL ship a checked-in, versioned catalog of reference datasets through its public package surface. Each dataset SHALL have a stable id, version, title, description, source URL, license URL or license identifier, recommendation/group metadata, and at least one artifact, and MAY declare the organism it describes. Each artifact SHALL have the `https` URL of the third party that publishes it, a safe dataset-relative destination path, the logical format of its bytes, and a description of what it contains — and no size, digest, or integrity class.

An artifact's format SHALL be logical rather than incidental, independent of compression: a gzipped tab-separated mapping table is `tsv`, not `gz`. An artifact's contents description SHALL state the shape a caller must know in order to use the file — key columns, identifier space, or the object it deserialises to — rather than restating the dataset title. A dataset's organism SHALL be omitted when the dataset is species-agnostic or covers multiple species.

Catalog validation SHALL reject duplicate dataset ids, duplicate artifact destinations within a dataset, absolute or traversal-bearing destinations, non-`https` artifact URLs, an artifact missing its format or contents, and any stray size or digest field offered on an artifact.

#### Scenario: An embedder lists supported references

- **WHEN** an embedder reads the exported catalog
- **THEN** it receives the same validated dataset ids, versions, upstream URLs, organisms, artifact formats and contents descriptions, and source and licensing links as every other embedder using that harness version

#### Scenario: An unsafe catalog path is rejected

- **WHEN** a catalog artifact destination is absolute or contains a `..` traversal segment
- **THEN** catalog validation fails before an embedder can construct an install plan

#### Scenario: An undescribed artifact is rejected

- **WHEN** a catalog artifact omits its format or its contents description
- **THEN** catalog validation fails, because an artifact no consumer can recognise is one every consumer must reach by hardcoding its path

### Requirement: Reference integrity is uniform trust-on-first-use

The catalog SHALL carry no per-artifact size or digest, and there SHALL be no integrity class. Every artifact is authenticated over TLS at download time, and the bytes actually received are recorded in the install receipt so later verification can prove the local copy has not changed since install. A checked-in digest is deliberately not maintained: it would apply unevenly — only upstreams that publish immutable bytes could ever carry one — and would put on this project the burden of computing and re-syncing a value that a `current` upstream immediately makes stale. TLS authenticates the publisher, and the receipt catches post-install drift; the marginal supply-chain benefit of a reviewed digest does not justify that inconsistency and burden for public, re-downloadable reference data.

Descriptive metadata is not integrity metadata and is exempt from this prohibition: a format and a contents description are properties of the dataset as its publisher defines it, not of the bytes a particular download produced, so they neither require recomputation nor go stale when an upstream rebuilds.

#### Scenario: The catalog names a source and a shape, not a checksum

- **WHEN** a dataset is added to the catalog
- **THEN** its artifact carries an `https` URL, a destination path, a format, and a contents description — no size, digest, or integrity class — and adding a source requires no downloaded-and-hashed value

#### Scenario: Integrity is recovered from the receipt, not the catalog

- **WHEN** an installed file is later altered on disk
- **THEN** verification against the size and digest the receipt recorded at install reports it modified, even though the catalog never carried a digest

## ADDED Requirements

### Requirement: Reference data is discoverable by description rather than by location

The reference-discovery surface SHALL let a caller find a file by what it holds, so that no consumer needs to encode the install layout. It SHALL join each scanned file to the catalog entry that installed it and surface that entry's organism, format, and contents description alongside the path, SHALL match a text query against those descriptive fields as well as the path, and SHALL render the format and contents of a matched file — not only its path — so a caller can choose a reader and a species without opening the file.

Descriptive metadata SHALL only ever enrich an entry. A file with no receipt and no catalog match SHALL still be returned, because a user-provisioned store is as valid as a managed one, and an absent or empty store SHALL be reported as a normal state rather than an error.

#### Scenario: A caller resolves data by describing it

- **WHEN** a caller queries the inventory for a term that appears only in a catalogued file's contents description, not in its path
- **THEN** the file is returned, labelled with its organism and format, and rendered with the shape a caller needs to read it

#### Scenario: An unlabelled user file remains visible

- **WHEN** the store holds a file that no receipt names and no catalog entry matches
- **THEN** the file is still listed, with whatever labels exist, and its absence of metadata does not suppress it

#### Scenario: The layout is never the interface

- **WHEN** reference data is provisioned under a different install layout
- **THEN** a caller that resolves files by description continues to work unchanged, because no consumer encodes the directory structure
