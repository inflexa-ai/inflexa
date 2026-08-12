# report-session-agent Delta

## ADDED Requirements

### Requirement: The report turn reads the copied narrative, never the live memory

The turn assembly of a `report` thread MUST NOT inject the live working-memory render. The seed message in the child transcript carries the copy at the anchor, and that copy is the narrative record of the session. A live render sees state past the anchor, and that breaks the knowledge cap.

The assembly MUST read the thread type from the row that the turn preparation already loads. A `conversation` thread keeps the live render.

#### Scenario: A report turn carries no live render

- **WHEN** a turn runs on a `report` thread
- **THEN** the assembled tail holds no working-memory render, and the seed message stays the one narrative source

#### Scenario: A conversation turn keeps the live render

- **WHEN** a turn runs on a `conversation` thread
- **THEN** the assembled tail holds the working-memory render, as before
