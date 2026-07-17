# ai-sdk-provider-runtime — delta

## MODIFIED Requirements

### Requirement: Provider failures remain classified values

AI SDK provider calls SHALL map provider failures into the harness `ProviderError` union in the same semantic categories used by existing callers: auth, budget, tenant-blocked, provider, and client abort. A 401 SHALL map to a non-retryable `auth` error whose message names the credential, so an embedder can surface a re-authentication remedy. Client abort SHALL continue to propagate as abort control flow rather than as a classified provider error.

#### Scenario: Budget failure stays non-retryable

- **WHEN** the configured AI SDK provider reports an upstream budget or payment failure
- **THEN** the harness maps it to a non-retryable `ProviderError` with `type: "budget"`

#### Scenario: Credential failure maps to auth

- **WHEN** the configured AI SDK provider answers 401 because the credential behind the call is expired, revoked, or absent
- **THEN** the harness maps it to a non-retryable `ProviderError` with `type: "auth"`

#### Scenario: Client abort escapes classification

- **WHEN** an `AbortSignal` aborts an AI SDK model call
- **THEN** the abort propagates rather than being returned as a `ProviderError`
