## ADDED Requirements

### Requirement: One version for each thread
The store MUST hold at most one version for each thread, and a named unique constraint on the thread id enforces it. A second record for the same thread MUST refuse with the typed reason `thread_already_holds_version`, and no new row lands. The refusal maps from the constraint violation, and the record reads nothing before the insert.

#### Scenario: A second record on one thread refuses
- **WHEN** the caller records a second version for a thread that holds one
- **THEN** the record refuses with `thread_already_holds_version`, and the store holds one row for the thread

#### Scenario: Two threads each hold one version
- **WHEN** each of two threads records its first version
- **THEN** each thread holds one version

## MODIFIED Requirements

### Requirement: The reads of a thread
The store MUST give one version by its id, and the one version of a thread. A read parses the stored document and snapshot with the existing schemas. A row that fails the parse MUST read as a typed error, and an absent row reads as a normal absence. For a thread with no version, the thread read gives an absence.

#### Scenario: The version of a thread
- **WHEN** a thread holds a recorded version
- **THEN** the thread read gives that version

#### Scenario: An unknown id is a normal absence
- **WHEN** the caller reads a version id that no row holds
- **THEN** the read gives an absence value, and it gives no error

### Requirement: One report session records one version
A caller of the record operation MUST record at most one version for each report thread. The record lands one time, when the mechanical gate passes and the user accepts the report. Before the acceptance, the session iterates the draft, and no version row exists. A correction after the acceptance is a new report session, and its version names the earlier version through the parent link. The store enforces the rule, and a second record for one thread refuses as typed data.

#### Scenario: The accepted report records one time
- **WHEN** the report session records its accepted document
- **THEN** the thread holds one version

#### Scenario: A correction starts a new session
- **WHEN** the user asks for a correction after the acceptance
- **THEN** a new report session records the new version, and that version names the earlier version as its parent

## REMOVED Requirements

### Requirement: A stable id and a per-thread ordinal
**Reason**: The one-version policy makes the ordinal dead generality, and a dead capability invites use without the vision.
**Migration**: The requirement "One version for each thread" replaces it. The unique constraint on the thread id replaces the ordinal index, and the version id stays the stable identity.
