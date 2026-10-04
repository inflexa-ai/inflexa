# primary-storage Specification

## Purpose
The identifier scheme of the CLI. Each new identifier is a UUIDv7 that the call site mints inline, with no helper.
## Requirements
### Requirement: Each new identifier is a UUIDv7 that the call site mints
The system MUST mint each new identifier with `randomUUIDv7()` from `bun`, at the call site. This applies to a database row id, the anchor marker, and an event id. The system MUST NOT wrap the call in a helper such as `newId()`. It MUST NOT use `ulid` or `crypto.randomUUID()`. A UUIDv7 is time-sortable, and the runtime gives it with no dependency.

#### Scenario: A new row gets a UUIDv7
- **WHEN** the system mints the id of a new database row
- **THEN** the call site calls `randomUUIDv7()` directly, and the id is a version 7 UUID

#### Scenario: No helper wraps the id
- **WHEN** a module mints an id
- **THEN** it imports `randomUUIDv7` from `bun`, and no `newId()` helper exists
