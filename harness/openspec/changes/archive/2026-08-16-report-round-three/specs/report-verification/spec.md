## MODIFIED Requirements

### Requirement: The gate runs before the store
The record tool MUST run the full validation before `store.record`, on every record — the first and each later one alike. The validation MUST cover the finish, the resolution of every reference, the chart-encoding match, and the assert match. Only a pass MUST reach the store. A later record replaces the one version through the store contract. Thus a version state that the gate did not accept never lands. A failed gate on a later record MUST leave the stored version as it was. The record MUST write the document value that the gate validated. The one-per-thread rule of the store bounds a concurrent race.

The record MUST prune the output file of each derivation that the recorded document does not reference, after the version lands, on every record. The prune reaches only a path under the session `derived/` directory. The records stay append-only, because the bytes are reproducible from the script and the sources. A failed removal logs, and it changes no outcome.

#### Scenario: A failed gate records nothing
- **WHEN** one reference of the document fails its assert
- **THEN** the record refuses, and the store holds no new row

#### Scenario: A pass records one version
- **WHEN** the gate passes and the thread holds no version
- **THEN** the store records the version, and the tool gives the version id

#### Scenario: A re-record runs the gate again
- **WHEN** the agent amends a block after a record, previews, looks, and records again
- **THEN** the gate validates the amended document, and the one version carries it on a pass

#### Scenario: A failed re-record keeps the stored version
- **WHEN** a later record fails its gate
- **THEN** the stored version stays as the earlier record left it

#### Scenario: The record prunes the unused outputs
- **WHEN** the record lands a version whose document names one of two derivation outputs
- **THEN** the unused output file goes, the used one stays, and both records stay

#### Scenario: A dropped derivation prunes on the re-record
- **WHEN** an amend drops the one binding of a derivation output, and the agent records again
- **THEN** that output file goes at the re-record, and the derivation record stays

#### Scenario: A failed prune keeps the version
- **WHEN** the removal of an unused output throws
- **THEN** the version stands, and the log names the failed removal
