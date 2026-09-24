## ADDED Requirements

### Requirement: The chat-turn history load answers each unanswered tool call

The chat-turn assembly MUST answer each tool call of the loaded window that has no result. The answer MUST be the not-run error result that the loop gives at its exit, byte-identical (refer to the harness-agent-loop capability). The assembly MUST insert the answer as one `tool` message, directly after the assistant message of the call and the tool messages that follow it. It MUST NOT remove or change a stored message. The stored rows do not change, because the answer exists only in the assembled messages.

The answer is a pure function of the window. Thus each turn that loads the same window sends the same prefix, and the prompt cache reads it back. The assembly MUST log one warn with the ids and the names of the answered calls. The warn is the only record that the stored thread and the assembled messages differ.

#### Scenario: A stored unanswered call is answered in place

- **GIVEN** a stored window whose assistant message carries a tool call with no result, and a user message after it
- **WHEN** the chat turn assembles its messages
- **THEN** the assistant message is unchanged, and a `tool` message with the not-run result sits between it and the user message

#### Scenario: Two turns send the same prefix

- **GIVEN** a thread with a stored unanswered call
- **WHEN** two turns load the same window
- **THEN** the two assembled prefixes are byte-identical

#### Scenario: An answered call is not touched

- **GIVEN** a stored window in which each tool call has its result
- **WHEN** the chat turn assembles its messages
- **THEN** the assembly adds no message and logs no warn
