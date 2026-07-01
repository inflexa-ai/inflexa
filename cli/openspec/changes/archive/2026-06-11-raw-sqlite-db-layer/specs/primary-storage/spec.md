## ADDED Requirements

### Requirement: Initial schema migration
The primary database's first migration (version 1) SHALL create the sessions, messages, and parts tables with the same schema as the current `store.ts`, including indexes and foreign key constraints.

#### Scenario: Fresh database gets full schema
- **WHEN** the primary database is opened for the first time
- **THEN** the `sessions`, `messages`, and `parts` tables are created with proper columns, foreign keys (`ON DELETE CASCADE`), and indexes (`idx_messages_session`, `idx_parts_message`, `idx_parts_session`)

### Requirement: Session mutations
The system SHALL provide the following session write operations:

- `createSession(title?)` — create a session with a ULID, default title "New session", and current timestamps
- `updateSession(session)` — update the session's data and set `updatedAt` to current time

#### Scenario: Create session with default title
- **WHEN** `createSession()` is called without a title
- **THEN** a session is created with title "New session", a ULID id, and `createdAt`/`updatedAt` set to now

#### Scenario: Create session with custom title
- **WHEN** `createSession("My chat")` is called
- **THEN** a session is created with title "My chat"

#### Scenario: Update session
- **WHEN** `updateSession(session)` is called with a modified session object
- **THEN** the session's `data` column is updated and `updatedAt` is refreshed

### Requirement: Message mutations
The system SHALL provide `createMessage(sessionId, role)` to insert a message. The mutation SHALL generate a ULID for the id and set `createdAt` to the current time, returning the full `Message` object.

#### Scenario: Create message
- **WHEN** `createMessage(sessionId, "user")` is called
- **THEN** a message is inserted with a generated ULID, the given sessionId and role, and the full `Message` is returned

### Requirement: Part mutations
The system SHALL provide:

- `createPart(sessionId, messageId, text)` — insert a new part with a generated ULID, returning the full `TextPart`
- `updatePart(part)` — update an existing part's data column

#### Scenario: Create new part
- **WHEN** `createPart(sessionId, messageId, "Hello")` is called
- **THEN** a part is inserted with a generated ULID and the full `TextPart` is returned

#### Scenario: Update existing part
- **WHEN** `updatePart(part)` is called with a modified part object
- **THEN** the part's `data` column is updated in the database

### Requirement: Session queries
The system SHALL provide the following session read operations:

- `getSession(id)` — return the session object or `null` if not found
- `listSessions()` — return all sessions ordered by id descending (newest first)

#### Scenario: Get existing session
- **WHEN** `getSession(id)` is called with an existing session id
- **THEN** the deserialized Session object is returned

#### Scenario: Get non-existent session
- **WHEN** `getSession(id)` is called with an id that does not exist
- **THEN** `null` is returned

#### Scenario: List sessions
- **WHEN** `listSessions()` is called
- **THEN** all sessions are returned ordered by id descending

### Requirement: Session messages query
The system SHALL provide `getSessionMessages(sessionId)` that returns all messages for a session with their associated parts, ordered by id ascending.

#### Scenario: Get messages with parts
- **WHEN** `getSessionMessages(sessionId)` is called for a session with messages and parts
- **THEN** each message is returned as `{ info: Message, parts: Part[] }` with parts grouped by message id and ordered by part id ascending

#### Scenario: Get messages for empty session
- **WHEN** `getSessionMessages(sessionId)` is called for a session with no messages
- **THEN** an empty array is returned

### Requirement: ID generation utility
The system SHALL provide a `newId()` function that generates ULID identifiers, exported from the shared utility module.

#### Scenario: Generate unique ID
- **WHEN** `newId()` is called
- **THEN** a valid ULID string is returned
