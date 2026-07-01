# primary-storage Specification

## Purpose
TBD - created by archiving change raw-sqlite-db-layer. Update Purpose after archive.
## Requirements
### Requirement: Initial schema migration
The primary database's first migration (version 1) SHALL create the sessions, messages, and parts tables with the same schema as the current `store.ts`, including indexes and foreign key constraints.

#### Scenario: Fresh database gets full schema
- **WHEN** the primary database is opened for the first time
- **THEN** the `sessions`, `messages`, and `parts` tables are created with proper columns, foreign keys (`ON DELETE CASCADE`), and indexes (`idx_messages_session`, `idx_parts_message`, `idx_parts_session`)

### Requirement: Session queries
The system SHALL provide the following session read operations, each returning `Result<T, DbError>` with `{ type: "query_failed", op, cause }` on failure:

- `getSession(id)` — return `Result<Session | null, DbError>`
- `listSessions()` — return `Result<Session[], DbError>`

#### Scenario: Get existing session
- **WHEN** `getSession(id)` is called with an existing session id
- **THEN** `ok(session)` is returned with the deserialized Session object

#### Scenario: Get non-existent session
- **WHEN** `getSession(id)` is called with an id that does not exist
- **THEN** `ok(null)` is returned

#### Scenario: Get session with corrupt data
- **WHEN** `getSession(id)` is called and `JSON.parse` fails on the stored data
- **THEN** `err({ type: "query_failed", op: "getSession", cause })` is returned

#### Scenario: List sessions
- **WHEN** `listSessions()` is called
- **THEN** `ok(sessions)` is returned with all sessions ordered by id descending

#### Scenario: List sessions database error
- **WHEN** `listSessions()` is called and the database query fails
- **THEN** `err({ type: "query_failed", op: "listSessions", cause })` is returned

### Requirement: Session messages query
The system SHALL provide `getSessionMessages(sessionId)` that returns `Result<StoredMessage[], DbError>` with all messages for a session with their associated parts, ordered by id ascending.

#### Scenario: Get messages with parts
- **WHEN** `getSessionMessages(sessionId)` is called for a session with messages and parts
- **THEN** `ok(messages)` is returned with each message as `{ info: Message, parts: Part[] }` with parts grouped by message id and ordered by part id ascending

#### Scenario: Get messages for empty session
- **WHEN** `getSessionMessages(sessionId)` is called for a session with no messages
- **THEN** `ok([])` is returned

#### Scenario: Get messages database error
- **WHEN** `getSessionMessages(sessionId)` is called and the query fails
- **THEN** `err({ type: "query_failed", op: "getSessionMessages", cause })` is returned

### Requirement: Session mutations
The system SHALL provide the following session write operations, each returning `Result<T, DbError>` with `{ type: "mutation_failed", op, cause }` on failure:

- `createSession(title?)` — return `Result<Session, DbError>`
- `updateSession(session)` — return `Result<void, DbError>`

#### Scenario: Create session with default title
- **WHEN** `createSession()` is called without a title
- **THEN** `ok(session)` is returned with a session with title "New session", a ULID id, and `createdAt`/`updatedAt` set to now

#### Scenario: Create session with custom title
- **WHEN** `createSession("My chat")` is called
- **THEN** `ok(session)` is returned with a session with title "My chat"

#### Scenario: Create session database error
- **WHEN** `createSession()` is called and the INSERT fails
- **THEN** `err({ type: "mutation_failed", op: "createSession", cause })` is returned

#### Scenario: Update session
- **WHEN** `updateSession(session)` is called with a modified session object
- **THEN** `ok(undefined)` is returned and the session's `data` column is updated with `updatedAt` refreshed

### Requirement: Message mutations
The system SHALL provide `createMessage(sessionId, role)` returning `Result<Message, DbError>` with `{ type: "mutation_failed", op: "createMessage", cause }` on failure.

#### Scenario: Create message
- **WHEN** `createMessage(sessionId, "user")` is called
- **THEN** `ok(message)` is returned with a generated ULID, the given sessionId and role

#### Scenario: Create message FK violation
- **WHEN** `createMessage(sessionId, "user")` is called with a non-existent sessionId
- **THEN** `err({ type: "mutation_failed", op: "createMessage", cause })` is returned

### Requirement: Part mutations
The system SHALL provide:

- `createPart(sessionId, messageId, text)` — return `Result<TextPart, DbError>`
- `updatePart(part)` — return `Result<void, DbError>`

Both SHALL use `{ type: "mutation_failed", op, cause }` on failure.

#### Scenario: Create new part
- **WHEN** `createPart(sessionId, messageId, "Hello")` is called
- **THEN** `ok(part)` is returned with a generated ULID and the full `TextPart`

#### Scenario: Create part FK violation
- **WHEN** `createPart(sessionId, messageId, "Hello")` is called with a non-existent messageId
- **THEN** `err({ type: "mutation_failed", op: "createPart", cause })` is returned

#### Scenario: Update existing part
- **WHEN** `updatePart(part)` is called with a modified part object
- **THEN** `ok(undefined)` is returned and the part's `data` column is updated

### Requirement: ID generation utility
The system SHALL provide a `newId()` function that generates ULID identifiers, exported from the shared utility module.

#### Scenario: Generate unique ID
- **WHEN** `newId()` is called
- **THEN** a valid ULID string is returned

### Requirement: Capped recent-messages read query

The system SHALL provide a capped message-read query that returns the most-recent `limit` messages of a session with their parts, in oldest→newest order, as `Result<StoredMessage[], DbError>`. The cap SHALL be expressed in SQL (`ORDER BY id ASC` is achieved by selecting newest-first with `ORDER BY id DESC LIMIT $limit` and reversing the result), never by loading the full history and slicing in JS. Each returned message SHALL carry its parts assembled in id order, identical in shape to the uncapped query.

The existing uncapped full-history query (`listSessionMessages`) SHALL remain unchanged and continue to feed the engine's model-history build, which requires the complete conversation context.

#### Scenario: Returns only the newest N, oldest-first

- **WHEN** the capped query runs with `limit = 200` for a session holding 500 messages
- **THEN** it returns exactly the 200 most-recent messages
- **AND** they are ordered oldest→newest with their parts assembled in id order

#### Scenario: Fewer messages than the cap

- **WHEN** the capped query runs for a session with fewer than `limit` messages
- **THEN** it returns all of them, oldest→newest

#### Scenario: Uncapped query still returns full history

- **WHEN** `listSessionMessages` is called
- **THEN** it returns every message of the session, oldest→newest, unchanged by this change

