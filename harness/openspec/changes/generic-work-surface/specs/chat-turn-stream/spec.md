## ADDED Requirements

### Requirement: The stream of a turn carries the user message

The turn MUST write the `message-start` of the user message before the first frame of the reply. The frame MUST carry the sanitized user text, which is the text that the model gets. The turn stores the user message only with its first round, thus the stream is the only source of it before that round. The fold of the frames MUST give the user message with the id of the stream and its text.

#### Scenario: A client attaches to a turn that paused on its first request

- **GIVEN** a turn whose first model request waits in a pause, and a client that has no message of the turn
- **WHEN** the client reads the turn by its id, and folds the frames with `applyChatFrame`
- **THEN** the fold holds the user message with the id of the stream and the sanitized user text

#### Scenario: A second read gives the same user message

- **GIVEN** a turn that ended with a reply
- **WHEN** a client reads the turn again from its start
- **THEN** the fold holds one user message, with the same id and text as the fold of the first read
