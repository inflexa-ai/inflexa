# harness-runtime Delta

## ADDED Requirements

### Requirement: The provider fetch honors the configured request timeout

The connection can set `requestTimeoutMs`, in either mode. Then the composition root MUST give the provider a fetch whose transport permits a silent wait of at least that value. The realization MUST compose with the auth-injecting fetch when a credential source exists, and the credential behavior MUST NOT change. When the field is absent, the composition root MUST NOT install a transport override.

#### Scenario: A slow local model completes within the window

- **GIVEN** a connection with `requestTimeoutMs` above the runtime default
- **WHEN** the endpoint starts its response after the runtime default but within the window
- **THEN** the request completes and no transport timeout fires

#### Scenario: The credential path still refreshes

- **GIVEN** a direct connection with a credential source and `requestTimeoutMs`
- **WHEN** a request receives an HTTP 401
- **THEN** the auth-injecting fetch refreshes and retries exactly once, as before
