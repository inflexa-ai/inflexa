## ADDED Requirements

### Requirement: A client abort resolves the streaming chat with the accumulated partial

The streaming `AgentChat` wrapper SHALL, when the client abort signal ends the underlying stream, resolve successfully with a `ChatResponse` whose finish reason is `"aborted"` and whose assistant message carries exactly the text deltas already forwarded — it SHALL NOT re-throw the abort and SHALL NOT route it through the provider-error channel. An abort that fires before any delta arrived SHALL resolve the same way with an empty assistant message. `ChatResponse.finishReason` SHALL admit `"aborted"` alongside the AI SDK finish reasons, and the non-streaming `ChatProvider.chat` SHALL continue to propagate a client abort as a throw — `"aborted"` is producible only by the streaming wrapper, so durable workflow loops (which run on the non-streaming provider) keep their cancellation-by-throw semantics.

#### Scenario: An abort mid-stream yields the partial text

- **GIVEN** a streaming chat whose model has emitted several text deltas
- **WHEN** the client abort signal fires and the stream throws its abort
- **THEN** `chat` resolves with finish reason `"aborted"` and an assistant message containing exactly the concatenated deltas already forwarded

#### Scenario: An abort before the first delta yields an empty partial

- **GIVEN** a streaming chat call whose abort signal is already aborted (or fires before any delta)
- **WHEN** the stream throws its abort
- **THEN** `chat` resolves with finish reason `"aborted"` and an assistant message with no content

#### Scenario: A non-abort stream failure still reaches the error channel

- **GIVEN** a streaming chat whose underlying stream throws a non-abort SDK failure
- **WHEN** `chat` consumes the throw
- **THEN** it returns `err(ProviderError)` exactly as before — the abort resolution narrows only the abort case
