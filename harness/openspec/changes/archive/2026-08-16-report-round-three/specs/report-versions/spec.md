## RENAMED Requirements

- FROM: `### Requirement: A version is one immutable row`
- TO: `### Requirement: The one version of a thread replaces whole`

## MODIFIED Requirements

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

### Requirement: One report session records one version
The record MUST land any number of times inside one report session, and each landing replaces the one version of the thread. The last accepted state stands, thus the stored version equals the page that the user saw last. Before the first acceptance, the session iterates the draft, and no version row exists. A correction in a new session records a new version, and that version names the earlier version through the parent link. Thus a thread holds one version, and the version history of an analysis is the chain of its sessions.

#### Scenario: The amend loop lands on one row
- **WHEN** the session records, amends the draft, and records again
- **THEN** the thread holds one version, and it carries the amended document

#### Scenario: A correction starts a new session
- **WHEN** the user asks for a correction after the session ends
- **THEN** a new report session records the new version, and that version names the earlier version as its parent
