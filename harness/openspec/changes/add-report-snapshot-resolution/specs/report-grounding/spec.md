## MODIFIED Requirements

### Requirement: A reference resolves against a pinned snapshot

The harness MUST expose a `ReferenceResolver` seam. Its `resolve(reference,
snapshot)` operation MUST return the concrete value, or a typed
`UnresolvedReference`. The `reason` MUST be one of `artifact-missing`,
`hash-mismatch`, `locator-out-of-range`, `ambiguous-match`, `assertion-failed`, or
`unreadable-artifact`. Resolution MUST target the pinned snapshot, so a version
resolves to the same value over time.

Resolution MUST have two tiers. The structural tier answers from the snapshot alone,
and it opens no file. The value tier reads the artifact, and it gives the cell.

A caller MUST be able to run the structural tier alone. Thus an authoring operation
validates a reference with no read of a file, and the costly read happens one time
for each version.

#### Scenario: A reference to a real cell resolves to its value

- **WHEN** a reference addresses a real cell in a pinned artifact
- **THEN** resolution returns the value at that cell

#### Scenario: A missing artifact returns artifact-missing

- **WHEN** a reference names a path that the snapshot does not hold
- **THEN** resolution returns an `UnresolvedReference` with reason `artifact-missing`

#### Scenario: A hash mismatch returns hash-mismatch

- **WHEN** a reference names a path whose content hash differs from the pinned `hash`
- **THEN** resolution returns an `UnresolvedReference` with reason `hash-mismatch`

#### Scenario: A locator past the last row returns locator-out-of-range

- **WHEN** a locator addresses a row or a cell that the artifact does not contain
- **THEN** resolution returns an `UnresolvedReference` with reason `locator-out-of-range`

#### Scenario: An artifact that no resolver can read returns unreadable-artifact

- **WHEN** a reference addresses a cell in an artifact that the resolver cannot read as a table
- **THEN** resolution returns an `UnresolvedReference` with reason `unreadable-artifact`

#### Scenario: The structural tier opens no file

- **WHEN** a caller runs the structural tier on a reference
- **THEN** the tier answers from the snapshot, and it reads no artifact
