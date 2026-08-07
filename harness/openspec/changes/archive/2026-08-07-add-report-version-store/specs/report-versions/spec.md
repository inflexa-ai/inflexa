## ADDED Requirements

### Requirement: A version is one immutable row
A recorded version MUST hold the block document, the snapshot, and the anchor on one row. The anchor is the analysis id, the thread id, the parent thread id, and the parent seq. The store MUST NOT update or replace a recorded version. A correction is a new version.

#### Scenario: The triple round-trips
- **WHEN** the caller records a version and reads it back by its id
- **THEN** the document, the snapshot, and the anchor equal the recorded values

#### Scenario: No update operation exists
- **WHEN** a caller inspects the store surface
- **THEN** the surface holds record and read operations only, and no operation changes a recorded row

### Requirement: A stable id and a per-thread ordinal
Each version MUST get a stable version id and an ordinal that is unique inside its thread. The first version of a thread holds the ordinal 1. The next ordinal is the maximum of the thread plus one. When two records race, the unique index refuses one insert, and the store tries the insert again one time. When the second insert also loses, the store gives the typed database error.

#### Scenario: The ordinals count up inside one thread
- **WHEN** the caller records three versions in one thread
- **THEN** the versions hold the ordinals 1, 2, and 3

#### Scenario: Two threads count independently
- **WHEN** each of two threads records its first version
- **THEN** each version holds the ordinal 1

### Requirement: A parent version link records reuse
A version can name a parent version with its stable id. The link is optional, because a first version has no parent. The parent MUST belong to the same analysis, and the record refuses a parent outside it. An unknown parent id refuses through the foreign key. When a cascade or an out-of-band delete removes the parent row, the link of the child MUST become null, and the child row stays.

#### Scenario: Version 2 names version 1
- **WHEN** the caller records a version with the id of an earlier version as the parent
- **THEN** the read of the new version gives that parent id

#### Scenario: A parent from a different analysis refuses
- **WHEN** the caller records a version whose parent id belongs to a different analysis
- **THEN** the record returns a typed refusal, and the store holds no new row

### Requirement: The record operation validates the document
The record operation MUST parse the document against the full document schema before the insert. A malformed document MUST refuse as typed data on the error channel, and no row lands. The operation MUST NOT run the reference validation, and it MUST NOT mint a snapshot. The caller gives the snapshot value, and the store stores it as given. The store stores the anchor as given, and the caller owns its truth.

#### Scenario: A malformed document refuses
- **WHEN** the caller records a value that the document schema refuses
- **THEN** the record returns a typed refusal, and the store holds no new row

#### Scenario: The stored snapshot is the given snapshot
- **WHEN** the caller records a version, and the artifact ledger changes afterward
- **THEN** the read of the version gives the snapshot as it was at the record

### Requirement: The reads of a thread
The store MUST give one version by its id, the latest version of a thread, and the version list of a thread. The list is in ordinal order. A read parses the stored document and snapshot with the existing schemas. A row that fails the parse MUST read as a typed error, and an absent row reads as a normal absence. For a thread with no versions, the latest read gives an absence, and the list gives an empty list.

#### Scenario: The latest version of a thread
- **WHEN** a thread holds the ordinals 1, 2, and 3
- **THEN** the latest read gives the version with the ordinal 3

#### Scenario: An unknown id is a normal absence
- **WHEN** the caller reads a version id that no row holds
- **THEN** the read gives an absence value, and it gives no error

### Requirement: A version resolves against its own snapshot
The snapshot value that a read gives MUST work with the existing structural validation unchanged. Thus the references of a stored version validate against the state at their anchor, and the numbers of a version never drift.

#### Scenario: A stored version stays valid after the analysis moves on
- **WHEN** a version records with a snapshot, and a later run adds new artifacts to the ledger
- **THEN** the structural validation of the stored document against the stored snapshot gives the same result as at the record

### Requirement: A version outlives its thread
A delete of a report thread MUST NOT remove the versions that the thread recorded. The versions of an analysis leave the store in the purge of the analysis, and only there.

#### Scenario: The thread dies, and the versions stay
- **WHEN** the report thread of a recorded version is deleted
- **THEN** the read of the version by its id still gives the version
