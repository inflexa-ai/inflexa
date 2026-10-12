# Spec Delta

## MODIFIED Requirements

### Requirement: Reference installation receipts record what was actually received

The harness MUST define a versioned receipt contract. The receipt MUST hold these fields:

- the dataset id and the dataset version
- the activation timestamp
- the content digest
- for each installed artifact, its relative path, and the byte size and the SHA-256 digest **observed at install time**.

A receipt MUST be optional metadata. If a receipt is absent or invalid, the files of the dataset MUST stay available.

The observed digests MUST NOT come from the catalog, because the catalog holds no digest. The receipt is the only record of the bytes that the upstream served at install time. Thus later verification compares the files against the receipt.

The content digest MUST be the lowercase hex SHA-256 of the UTF-8 bytes of one compact JSON array. The array is `[datasetId, datasetVersion, [[path, bytes, sha256], ...]]`. The artifact entries MUST be in ascending code-unit order of `path`.

The activation timestamp MUST NOT enter the content digest. Thus two installs of the same dataset version with the same bytes have the same content digest.

The harness MUST expose the calculation of the content digest, so that each embedder writes the same value. The parse MUST reject a receipt whose content digest is not equal to the digest of its own fields.

#### Scenario: Different embedders describe the same installation

- **WHEN** local and managed installers activate the same install plan
- **THEN** each can emit a receipt that validates against the same harness-owned contract

#### Scenario: An install is still verifiable afterwards

- **WHEN** an installed artifact's bytes are later altered on disk
- **THEN** verification against the receipt reports the file as modified, even though the catalog never carried a digest for it

#### Scenario: Invalid receipt does not hide files

- **WHEN** discovery encounters an invalid or stale receipt beside readable reference files
- **THEN** it reports the filesystem content without receipt enrichment rather than treating the store as unavailable

#### Scenario: The same bytes installed at different times share one content digest

- **WHEN** two installs of the same dataset version observe the same path, size, and digest for each artifact at different activation times
- **THEN** the receipts have different activation timestamps and the same content digest

#### Scenario: The content digest does not depend on artifact order

- **WHEN** two receipts list the same artifacts in a different order
- **THEN** the two receipts have the same content digest

#### Scenario: A receipt of an older contract version is rejected

- **WHEN** a receipt has a version other than the current receipt version, even with a correct content digest
- **THEN** the parse rejects the receipt as invalid

#### Scenario: A content digest that disagrees with the receipt is rejected

- **WHEN** the content digest of a receipt is not equal to the digest of its dataset id, dataset version, and artifacts
- **THEN** the parse rejects the receipt as invalid
