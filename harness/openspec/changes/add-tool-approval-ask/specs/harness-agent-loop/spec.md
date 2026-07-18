## ADDED Requirements

### Requirement: A denied tool approval terminates the turn

When a tool's user-approval request (see the tool-approval spec) is rejected, the tool's `execute` throws, and the AI SDK loop integration SHALL map that rejection to a model-visible `execution-denied` tool result carrying the user's feedback, then SHALL hard-stop the turn: concurrently dispatched sibling tool calls from the same reply run to completion and their results are appended alongside the denial, but the loop SHALL make no subsequent model call — no further tool-calling iteration and no tool-less wrap-up. The denial tool result is the turn's final content. This is distinct from the recoverable error-tool-result path: an ordinary tool error is one the model reads and retries around, whereas a denial ends the turn so the agent cannot flail against the user's decision. An approval (`once`/`always`) SHALL NOT terminate the turn — the tool proceeds and the loop continues normally.

#### Scenario: A rejected approval hard-stops the turn

- **GIVEN** a turn in which a tool's approval request is answered `reject`
- **WHEN** the loop dispatches that tool call
- **THEN** the turn's results carry a model-visible `execution-denied` result with the feedback, and the loop makes no subsequent model call — no further tool-calling iteration and no wrap-up

#### Scenario: Concurrent siblings complete before the stop

- **GIVEN** a reply whose parallel tool calls include one denied approval and one ordinary tool
- **WHEN** the loop processes the turn
- **THEN** the ordinary tool's result is appended alongside the denial, and the loop then stops

#### Scenario: The denial is distinguished from a recoverable tool error

- **GIVEN** a turn with one denied approval and no other failing tool
- **WHEN** the loop processes the results
- **THEN** it terminates the turn rather than continuing as it would for an ordinary retryable tool error

#### Scenario: An approved request does not terminate the turn

- **GIVEN** a turn in which a tool's approval request is answered `once`
- **WHEN** the loop dispatches that tool call
- **THEN** the tool proceeds to its guarded action and the loop continues normally
