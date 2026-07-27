# primary-storage Specification

## Purpose
TBD - created by archiving change raw-sqlite-db-layer. Update Purpose after archive.
## Requirements
### Requirement: ID generation utility
The system SHALL provide a `newId()` function that generates ULID identifiers, exported from the shared utility module.

#### Scenario: Generate unique ID
- **WHEN** `newId()` is called
- **THEN** a valid ULID string is returned
