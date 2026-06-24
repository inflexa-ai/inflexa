## ADDED Requirements

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
