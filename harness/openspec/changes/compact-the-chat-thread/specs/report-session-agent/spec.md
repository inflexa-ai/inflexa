## MODIFIED Requirements

### Requirement: The window of a report turn keeps the seed

The view of a report turn MUST keep the first turn of the thread in front. The seed is that first turn, and it is the one record of the brief and of the working memory. No later record replaces it.

After a summary marker, the view MUST hold the seed, then the summary, then each later message. After a drop marker, the view MUST hold the seed, the last good summary when one exists, and the kept turns. Thus a long session keeps its objective, and the agent never loses its brief. The seed carries a length bound, thus its cost in each view stays bounded.

A `conversation` thread MUST keep no head. Its view starts at the latest summary, and its working-memory record comes after the summary (see the chat-turn capability). Thus the first turn of a conversation holds no record that a later turn needs.

#### Scenario: A compacted report session keeps its seed first

- **GIVEN** a report thread whose turns passed the budget, and a summary marker in a later turn
- **WHEN** the next turn is prepared
- **THEN** the messages start with the seed, and then the summary marker

#### Scenario: A drop in a report session keeps the seed and the summary

- **GIVEN** a report thread with a summary marker and a later drop marker
- **WHEN** the next turn is prepared
- **THEN** the messages start with the seed, then the summary marker, and then the kept turns

#### Scenario: A conversation view starts at the summary

- **GIVEN** a `conversation` thread with a summary marker
- **WHEN** the next turn is prepared
- **THEN** the messages start with the summary marker, and no message of an earlier turn comes before it
