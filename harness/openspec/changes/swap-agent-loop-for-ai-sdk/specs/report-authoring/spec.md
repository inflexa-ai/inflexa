## ADDED Requirements

### Requirement: The report agent runs one tool call at a time

The report agent MUST ask the provider for one tool call for each reply. The option stays the same for each request of the conversation, thus the prompt prefix does not change. Two edits of the draft then never land in the same round.

#### Scenario: An anchor names a block of the previous call

- **GIVEN** a report agent that added a block in its previous call
- **WHEN** it moves another block after that block
- **THEN** the anchor resolves, because each call lands before the next one starts
