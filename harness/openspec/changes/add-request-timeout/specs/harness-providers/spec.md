# harness-providers Delta

## ADDED Requirements

### Requirement: ChatProvider advertises an optional request-timeout limit

The `ChatProvider` interface MUST carry an optional readonly `requestTimeoutMs` field. A provider that enforces a request timeout MUST advertise the enforced value there. A consumer that scales a deadline from the provider MUST read this field from the provider instance in its deps, not from a harness constant. An absent field means that the provider enforces no request timeout of its own.

#### Scenario: A configured provider advertises its limit

- **WHEN** a provider is constructed from a configuration that sets `requestTimeoutMs`
- **THEN** the provider instance exposes the same value on its `requestTimeoutMs` field

#### Scenario: A provider without a limit stays unchanged

- **WHEN** a provider is constructed from a configuration without `requestTimeoutMs`
- **THEN** the `requestTimeoutMs` field of the instance is absent
- **AND** each consumer applies its own default deadline
