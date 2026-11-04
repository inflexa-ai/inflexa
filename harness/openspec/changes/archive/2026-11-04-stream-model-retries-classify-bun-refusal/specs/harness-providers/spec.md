# Spec Delta

## ADDED Requirements

### Requirement: The connection check knows the connection failures of Bun

The classification MUST treat a connection that the endpoint refuses or resets as a retryable `provider` failure under Node and under Bun. The fetch of Bun gives its own code for a refused connection, and the classification MUST know that code. A model call that fails after its retries on such a failure is thus an `outage`, and a turn pauses on it.

#### Scenario: Bun refuses the connection

- **GIVEN** a model call under Bun whose endpoint refuses the connection
- **AND** the AI SDK error has no status, and its cause is a fetch error with the code `ConnectionRefused`
- **WHEN** the failure is classified
- **THEN** the `ProviderError` has `type: "provider"` and `retryable: true`
- **AND** a model call that fails after its retries on it is an `outage`

#### Scenario: Bun resets the connection

- **GIVEN** a model call under Bun whose connection closes before the response ends
- **AND** the fetch error has the code `ECONNRESET` and no status
- **WHEN** the failure is classified
- **THEN** the `ProviderError` has `type: "provider"` and `retryable: true`
