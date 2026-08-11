# harness-providers Delta

## ADDED Requirements

### Requirement: chatStream surfaces a mid-stream timeout as an error event

`chatStream` MUST map the SDK `abort` stream part to a terminal provider error that names the timeout. A quiet stream end with partial text after a timeout MUST be unrepresentable on the harness surface. When the abort signal of the caller is aborted, the cancellation path MUST apply unchanged.

#### Scenario: A mid-stream timeout becomes an error event

- **GIVEN** a stream whose content stalls past the configured window
- **WHEN** the SDK aborts the stream and emits its `abort` part
- **THEN** `chatStream` terminates with a provider error that names the timeout
- **AND** the partial text does not end the stream quietly

#### Scenario: A caller abort stays a cancellation

- **GIVEN** a caller that aborts its signal mid-stream
- **WHEN** the stream ends with the SDK `abort` part
- **THEN** the cancellation path applies, not the timeout error
