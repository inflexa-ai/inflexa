## MODIFIED Requirements

### Requirement: The fall-through takes every doubt
An over-cap file, an unknown format, and a host parse fault MUST take the fall-through. The host arm MUST NOT give a partial or guessed answer. Thus correctness never depends on the host parser. The realization has no sandbox arm, thus the fall-through gives a typed failure and no value.

#### Scenario: A parse fault falls through
- **WHEN** the host parser fails on an odd CSV dialect
- **THEN** the reference fails with `extraction-unavailable`, and the failure gives no guessed value from the host fault

## ADDED Requirements

### Requirement: A reference on the fall-through is a typed failure
A reference on the fall-through path MUST fail with the reason `extraction-unavailable`. The detail MUST state that the realization reads no file outside the host arm. The host arm MUST keep serving the under-cap files. No sandbox starts for a reference.

#### Scenario: The under-cap majority survives the fall-through
- **WHEN** a document holds one over-cap reference and nine under-cap references
- **THEN** the nine resolve, and the one fails with `extraction-unavailable`
- **AND** no sandbox starts

## REMOVED Requirements

### Requirement: The sandbox arm submits one fixed script

**Reason**: The report-value resolution loses its sandbox arm. The arm was a consumer with no lease, and the report refactor removes it.

**Migration**: A reference that the host arm cannot read fails with `extraction-unavailable`. A report binds an artifact that the host arm can read under the cap.

### Requirement: An absent sandbox arm is a typed failure

**Reason**: The realization has no sandbox arm, thus the arm is never wired. A MODIFIED block cannot change the scenario, thus the requirement continues under a new name.

**Migration**: Refer to the ADDED requirement "A reference on the fall-through is a typed failure".
