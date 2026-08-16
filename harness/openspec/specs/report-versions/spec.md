# report-versions Specification

## Purpose

Define the store of a report version. A version is a checkpoint: the block
document, the snapshot that its references pin to, and the anchor into the
parent conversation. The producers exist in other capabilities — the finish of
`report-authoring` gives the document, and the mint of `report-snapshot` gives
the pinned set. This capability records the triple, and it never computes one.

A version is immutable and append-only. The user does more investigation, and
then the user asks for a new report. The new version must show the later state.
The earlier version must keep the state that it recorded. Thus a version is a
checkpoint, and it is not a live view.

A thread is a scaffold, and a version is a deliverable. Thus a version outlives
its thread, and it dies only in the purge of its analysis. The `analysis-purge`
capability lists the version table in the purged footprint.

A publish is a boundary crossing, and it is not a reference. A version dies
with its analysis, and the workspace files can leave first. Thus a consumer that
publishes a version renders the page at publish time. It copies the bytes and
the metadata into its own store, and it owns them. A published entity that points
into the workspace, or at the version row, becomes an orphan.

## Requirements

### Requirement: The one version of a thread replaces whole
A recorded version MUST hold the block document, the snapshot, and the anchor on one row. The anchor is the analysis id, the thread id, the parent thread id, and the parent seq. A record on a thread that holds a version MUST replace the document, the snapshot, and the anchor of that row, whole. The version id of the row stays, thus a consumer that names the version keeps its name. A partial update is not representable: the store takes the full triple, and it writes the full triple.

#### Scenario: The triple round-trips
- **WHEN** the caller records a version and reads it back by its id
- **THEN** the document, the snapshot, and the anchor equal the recorded values

#### Scenario: A later record replaces the row
- **WHEN** the caller records again on the same thread with an amended document
- **THEN** the read gives the amended document, and the version id is unchanged

#### Scenario: No partial update exists
- **WHEN** a caller inspects the store surface
- **THEN** the surface holds record and read operations only, and a record takes the whole triple

### Requirement: One version for each thread
The store MUST hold at most one version for each thread, and a named unique constraint on the thread id enforces it. A record for a thread that holds a version MUST replace that row, and no second row lands. The `thread_already_holds_version` refusal retires, because the replace is the intended outcome. The record MUST report whether it created or replaced, thus the caller names the outcome honestly.

#### Scenario: A second record on one thread replaces
- **WHEN** the caller records a second version for a thread that holds one
- **THEN** the store holds one row for the thread, and the row carries the second document

#### Scenario: Two threads each hold one version
- **WHEN** each of two threads records its first version
- **THEN** each thread holds one version

#### Scenario: The record names the outcome
- **WHEN** the caller records on a fresh thread, and then again on the same thread
- **THEN** the first record reports a creation, and the second reports a replacement

### Requirement: A parent version link records reuse
A version can name a parent version with its stable id. The link is optional, because a first version has no parent. The parent MUST belong to the same analysis, and the record refuses a parent outside it. An unknown parent id refuses through the foreign key. When a cascade or an out-of-band delete removes the parent row, the link of the child MUST become null, and the child row stays.

#### Scenario: Version 2 names version 1
- **WHEN** the caller records a version with the id of an earlier version as the parent
- **THEN** the read of the new version gives that parent id

#### Scenario: A parent from a different analysis refuses
- **WHEN** the caller records a version whose parent id belongs to a different analysis
- **THEN** the record returns a typed refusal, and the store holds no new row

### Requirement: The record operation validates the document
The record operation MUST parse the document against the full document schema before the insert. It MUST parse the snapshot against the snapshot schema in the same way. A malformed document or a malformed snapshot MUST refuse as typed data on the error channel, and no row lands. The shape parse changes no value.

The operation MUST NOT run the reference validation, and it MUST NOT mint a snapshot. The caller gives the snapshot value, and the store stores it as given. The store stores the anchor as given, and the caller owns its truth.

#### Scenario: A malformed document refuses
- **WHEN** the caller records a value that the document schema refuses
- **THEN** the record returns a typed refusal, and the store holds no new row

#### Scenario: A malformed snapshot refuses
- **WHEN** the caller records a version whose snapshot fails the snapshot schema
- **THEN** the record returns a typed refusal, and the store holds no new row

#### Scenario: The stored snapshot is the given snapshot
- **WHEN** the caller records a version, and the artifact ledger changes afterward
- **THEN** the read of the version gives the snapshot as it was at the record

### Requirement: The reads of a thread
The store MUST give one version by its id, and the one version of a thread. A read parses the stored document and snapshot with the existing schemas. A row that fails the parse MUST read as a typed error, and an absent row reads as a normal absence. For a thread with no version, the thread read gives an absence.

#### Scenario: The version of a thread
- **WHEN** a thread holds a recorded version
- **THEN** the thread read gives that version

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

### Requirement: One report session records one version
The record MUST land any number of times inside one report session, and each landing replaces the one version of the thread. The last accepted state stands, thus the stored version equals the page that the user saw last. Before the first acceptance, the session iterates the draft, and no version row exists. A correction in a new session records a new version, and that version names the earlier version through the parent link. Thus a thread holds one version, and the version history of an analysis is the chain of its sessions.

#### Scenario: The amend loop lands on one row
- **WHEN** the session records, amends the draft, and records again
- **THEN** the thread holds one version, and it carries the amended document

#### Scenario: A correction starts a new session
- **WHEN** the user asks for a correction after the session ends
- **THEN** a new report session records the new version, and that version names the earlier version as its parent

