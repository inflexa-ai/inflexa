## MODIFIED Requirements

### Requirement: Provider failures remain classified values

AI SDK provider calls MUST map provider failures into the harness `ProviderError` union with the kinds `auth`, `suspend`, and `provider`. A status in the `suspendOn` map of the provider MUST map to a non-retryable `suspend` error with the status and the reason of the map. A 401 SHALL map to a non-retryable `auth` error whose message names the credential, so an embedder can surface a re-authentication remedy. Client abort SHALL continue to propagate as abort control flow rather than as a classified provider error.

#### Scenario: A mapped status stays non-retryable

- **WHEN** the configured AI SDK provider answers with a status in its `suspendOn` map
- **THEN** the harness maps the failure to a non-retryable `ProviderError` with `type: "suspend"`, the status, and the reason of the map

#### Scenario: An unmapped 403 is a provider error

- **WHEN** the configured AI SDK provider answers `403`, and its `suspendOn` map does not hold `403`
- **THEN** the harness maps the failure to a non-retryable `ProviderError` with `type: "provider"`

#### Scenario: Credential failure maps to auth

- **WHEN** the configured AI SDK provider answers 401 because the credential behind the call is expired, revoked, or absent
- **THEN** the harness maps it to a non-retryable `ProviderError` with `type: "auth"`

#### Scenario: Client abort escapes classification

- **WHEN** an `AbortSignal` aborts an AI SDK model call
- **THEN** the abort propagates rather than being returned as a `ProviderError`
