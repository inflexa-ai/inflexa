# chat-view — delta

## ADDED Requirements

### Requirement: Provider auth failures surface the re-authentication remedy

When a failed turn's cause chain carries a harness `ProviderError` with `type: "auth"` (at any depth — the AI SDK wraps it), the error banner SHALL render a dedicated message naming the configured connection provider (`models.connection.provider`) and the remedies: restart the chat (the launch gate re-authenticates) or run the forced re-login command. When the connection config carries no provider slug, the banner SHALL fall back to the generic cause rendering. Detection SHALL be structural (walking the cause chain for the `type` discriminant), never by matching provider message text.

#### Scenario: An auth turn failure names the provider and the remedy

- **GIVEN** a cliproxy connection recorded with provider `anthropic`
- **WHEN** a turn fails and its cause chain carries `{ type: "auth", retryable: false }`
- **THEN** `errorMsg` names the provider login as expired and gives the restart / forced re-login remedies, and `chatStatus` is `error`

#### Scenario: An auth failure without a recorded provider falls back to generic rendering

- **WHEN** a turn fails with a `type: "auth"` cause but `models.connection` carries no provider slug
- **THEN** the banner renders the generic cause description (which still carries the auth kind and its credential-naming message)
