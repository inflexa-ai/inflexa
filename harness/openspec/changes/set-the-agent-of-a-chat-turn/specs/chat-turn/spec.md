## ADDED Requirements

### Requirement: A chat turn opens before it runs

The harness MUST give `openChatTurn(deps, { analysisId, threadId, userInput })`. It MUST prepare the turn and resolve the agent of the thread type. It MUST give one of these results:

- `prepare_failed`, `not_found`, or `agent_unresolved`, as `runChatTurn` gives them
- `ready`, with the resolved `agent` and a `run` function that takes the transport values of the turn

A refusal MUST come back before the turn writes a row or a turn record. Thus a host can answer a refusal before it starts a stream. `runChatTurn` MUST be `openChatTurn` and then `run`.

#### Scenario: A thread of a different analysis is refused at the open

- **GIVEN** a thread that a different analysis owns
- **WHEN** a host calls `openChatTurn` on it
- **THEN** the result is `not_found`, and the thread holds no row and no turn record of the turn

### Requirement: The harness sets the provenance of the root agent of a chat turn

The host MUST give the session of a turn with no provenance. The harness MUST set the provenance of the session to the id of the resolved agent, with a call path that holds only that id. Thus the billing headers, the usage records, and the provenance events of the turn carry the id of the agent that ran it.

#### Scenario: A report thread runs under the id of the report agent

- **GIVEN** a thread of the type `report`, and a resolver that gives the report agent for that type
- **WHEN** a host opens the turn and runs it
- **THEN** the open turn gives the report agent, and each usage record of the run carries the id of that agent

### Requirement: The display of the user message holds the sanitized text

The display projection of the user message MUST hold the same sanitized text as the model message. Thus the stored display never holds a secret that the redaction removed from the model message.

#### Scenario: A pasted key does not reach the stored display

- **GIVEN** a user input that holds an API key
- **WHEN** a turn stores its opening
- **THEN** the stored display of the user message holds the redacted text, and not the key
