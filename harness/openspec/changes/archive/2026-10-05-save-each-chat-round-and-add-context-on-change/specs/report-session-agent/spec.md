## MODIFIED Requirements

### Requirement: The report turn reads the copied narrative, never the live memory

The turn assembly of a `report` thread MUST NOT add a working-memory record. The seed message in the child transcript carries the copy at the anchor, and that copy is the narrative record of the session. A live render sees state past the anchor, and that breaks the knowledge cap.

The assembly MUST read the thread type from the row that the turn preparation already loads. A `conversation` thread keeps the working-memory record (see the chat-turn capability).

#### Scenario: A report turn carries no live render

- **WHEN** a turn runs on a `report` thread
- **THEN** the turn adds no working-memory record, and the seed message stays the one narrative source

#### Scenario: A conversation turn keeps the live render

- **GIVEN** a `conversation` thread whose window holds no working-memory record
- **WHEN** a turn runs on that thread
- **THEN** the turn adds a working-memory record after the user message

### Requirement: The window of a report turn keeps the seed

The history window of a report turn MUST keep the first turn of the thread. The seed is that first turn, and it is the one record of the brief and of the working memory. No later record replaces it.

The window evicts the oldest turn first. Thus a long session would drop the seed, and the agent would keep its tools and lose its objective. The retained seed can carry the window past its token budget. The cost is bounded, because the brief carries a length bound and the render is one row.

A `conversation` thread MUST keep the eviction that it has. A conversation turn adds the working-memory record again when the window holds no copy of it. Thus the first turn of a conversation holds no record that a later turn needs.

#### Scenario: A long report session keeps its seed

- **WHEN** a report thread holds more turns than the token budget admits
- **THEN** the window holds the seed, and it holds the most recent turns

#### Scenario: A conversation window evicts its oldest turn

- **WHEN** a conversation thread holds more turns than the token budget admits
- **THEN** the window drops the oldest turns, as before
