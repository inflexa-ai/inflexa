## ADDED Requirements

### Requirement: The gate runs before each record
The record tool MUST run the full validation before `store.record`, on every record — the first and each later one alike. The validation MUST cover the finish, the resolution of every reference, the chart-encoding match, and the assert match. Only a pass MUST reach the store. A later record replaces the one version through the store contract. Thus a version state that the gate did not accept never lands. A failed gate on a later record MUST leave the stored version as it was. The record MUST write the document value that the gate validated. The one-per-thread rule of the store bounds a concurrent race.

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

## REMOVED Requirements

### Requirement: A derivation is repeatable

**Reason**: The report session loses `derive_table`, thus no session makes a derivation record.

**Migration**: None. A report binds the pinned artifacts, and the pin of each artifact holds its hash.

### Requirement: The gate runs before the store

**Reason**: The requirement drops the prune of the derivation outputs. A MODIFIED block cannot drop a scenario, thus the requirement continues under a new name.

**Migration**: Refer to the ADDED requirement "The gate runs before each record".
