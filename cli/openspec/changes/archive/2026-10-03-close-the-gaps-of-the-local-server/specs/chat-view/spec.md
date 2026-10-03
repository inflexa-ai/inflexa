## MODIFIED Requirements

### Requirement: Provider auth failures surface the re-authentication remedy

A failed turn can carry a harness `ProviderError` with `type: "auth"` at any depth of its cause chain, because the AI SDK wraps it. Then the local server MUST give the turn a failure message that names the resolved connection provider and its remedy. The error banner MUST render that message:

- In `cliproxy` mode, the remedy is `inflexa up` in a terminal, or the forced re-login command. `inflexa up` signs in and restarts the proxy, thus the server needs no restart.
- In `direct` mode, the remedy is a check of `INFLEXA_MODEL_API_KEY` and then `inflexa server stop`. The server reads the key at its boot, thus only the next server reads a new key. A re-login cannot fix the own key of the user.

The message MUST always name the provider. The resolved connection always carries a slug: `direct` requires one, and `cliproxy` defaults to `anthropic`. When no login flow owns the slug, the message MUST omit only the forced re-login command. Each other failure MUST use the generic rendering of the cause. The detection MUST be structural: the server walks the cause chain for the `type` discriminant, and it never matches the message text of the provider.

#### Scenario: An auth turn failure names the provider and the remedy

- **GIVEN** a cliproxy connection recorded with provider `anthropic`
- **WHEN** a turn fails and its cause chain carries `{ type: "auth", retryable: false }`
- **THEN** `errorMsg` names the provider login as expired, and it gives `inflexa up` and the forced re-login as the remedies
- **AND** `chatStatus` is `error`

#### Scenario: A direct connection's auth failure names the key, not a re-login

- **GIVEN** a `direct` connection
- **WHEN** a turn fails with a `type: "auth"` cause
- **THEN** the banner names `INFLEXA_MODEL_API_KEY` and `inflexa server stop`, and no re-login command

#### Scenario: An unrecognized provider slug drops only the re-login hint

- **WHEN** a turn fails with a `type: "auth"` cause and the recorded slug maps to no login flow
- **THEN** the banner still names that provider as expired, without a forced re-login command
