# chat-view — delta

## ADDED Requirements

### Requirement: Provider auth failures surface the re-authentication remedy

When a failed turn's cause chain carries a harness `ProviderError` with `type: "auth"` (at any depth — the AI SDK wraps it), the error banner SHALL render a dedicated message naming the resolved connection provider and its remedy: in `cliproxy` mode, restarting the chat (the launch gate re-authenticates) or the forced re-login command; in `direct` mode, the `INFLEXA_MODEL_API_KEY` variable, since a re-login cannot fix the user's own key. The banner SHALL name the provider unconditionally — the resolved connection always carries a slug (`direct` requires one, `cliproxy` defaults to `anthropic`), so there is no slug-less rendering. When the slug is one no login flow owns, the banner SHALL omit only the forced re-login command. Any non-auth failure SHALL fall back to the generic cause rendering. Detection SHALL be structural (walking the cause chain for the `type` discriminant), never by matching provider message text.

#### Scenario: An auth turn failure names the provider and the remedy

- **GIVEN** a cliproxy connection recorded with provider `anthropic`
- **WHEN** a turn fails and its cause chain carries `{ type: "auth", retryable: false }`
- **THEN** `errorMsg` names the provider login as expired and gives the restart / forced re-login remedies, and `chatStatus` is `error`

#### Scenario: A direct connection's auth failure names the key, not a re-login

- **GIVEN** a `direct` connection
- **WHEN** a turn fails with a `type: "auth"` cause
- **THEN** the banner names `INFLEXA_MODEL_API_KEY` and no re-login command

#### Scenario: An unrecognized provider slug drops only the re-login hint

- **WHEN** a turn fails with a `type: "auth"` cause and the recorded slug maps to no login flow
- **THEN** the banner still names that provider as expired, without a forced re-login command
