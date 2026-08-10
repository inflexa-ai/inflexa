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

### Requirement: A version is one immutable row
A recorded version MUST hold the block document, the snapshot, and the anchor on one row. The anchor is the analysis id, the thread id, the parent thread id, and the parent seq. The store MUST NOT update or replace a recorded version. A correction is a new version.

#### Scenario: The triple round-trips
- **WHEN** the caller records a version and reads it back by its id
- **THEN** the document, the snapshot, and the anchor equal the recorded values

#### Scenario: No update operation exists
- **WHEN** a caller inspects the store surface
- **THEN** the surface holds record and read operations only, and no operation changes a recorded row

### Requirement: One version for each thread
The store MUST hold at most one version for each thread, and a named unique constraint on the thread id enforces it. A second record for the same thread MUST refuse with the typed reason `thread_already_holds_version`, and no new row lands. The refusal maps from the constraint violation, and the record reads nothing before the insert.

#### Scenario: A second record on one thread refuses
- **WHEN** the caller records a second version for a thread that holds one
- **THEN** the record refuses with `thread_already_holds_version`, and the store holds one row for the thread

#### Scenario: Two threads each hold one version
- **WHEN** each of two threads records its first version
- **THEN** each thread holds one version

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
A caller of the record operation MUST record at most one version for each report thread. The record lands one time, when the mechanical gate passes and the user accepts the report. Before the acceptance, the session iterates the draft, and no version row exists. A correction after the acceptance is a new report session, and its version names the earlier version through the parent link. The store enforces the rule, and a second record for one thread refuses as typed data.

#### Scenario: The accepted report records one time
- **WHEN** the report session records its accepted document
- **THEN** the thread holds one version

#### Scenario: A correction starts a new session
- **WHEN** the user asks for a correction after the acceptance
- **THEN** a new report session records the new version, and that version names the earlier version as its parent
