## MODIFIED Requirements

### Requirement: Thread history is conversation-scoped

The `messages` table and `ThreadHistory` SHALL serve conversation threads only. Workflow and sandbox agent loops SHALL NOT write to it; their message durability is the DBOS step cache and is not migrated by the AI SDK thread-history backfill.

#### Scenario: The interface offers no generic message insert

- **GIVEN** the `ThreadHistory` type
- **WHEN** a caller inspects it
- **THEN** it exposes only conversation-turn operations (for example `appendTurn`, `writeTurn`, `loadRecent`, `loadAll`, and `retractLastTurn`), not a generic row insert or row delete
