# model-connection Delta

## ADDED Requirements

### Requirement: The connection accepts a request timeout and a retry count

Both arms of `models.connection` MUST accept optional `requestTimeoutMs` and `maxRetries` fields. The schema MUST accept only a positive integer for each. Boot MUST carry the values into the harness provider configuration for every per-model provider over the connection. An absent field MUST keep the current behavior.

#### Scenario: A configured timeout reaches the provider

- **WHEN** the connection is `{ mode: "direct", ..., requestTimeoutMs: 1800000 }`
- **THEN** each harness provider config that boot builds carries `requestTimeoutMs: 1800000`

#### Scenario: A cliproxy timeout reaches the provider

- **WHEN** the connection is `{ mode: "cliproxy", requestTimeoutMs: 1800000 }`
- **THEN** each harness provider config that boot builds carries `requestTimeoutMs: 1800000`

#### Scenario: A configured retry count reaches the provider

- **WHEN** the connection carries `maxRetries: 3`
- **THEN** each harness provider config that boot builds carries `maxRetries: 3`

#### Scenario: An absent field changes nothing

- **WHEN** the connection carries neither field
- **THEN** the provider config carries neither field
- **AND** boot behavior is identical to the behavior before this change

#### Scenario: An invalid value fails closed

- **WHEN** the config carries a zero, negative, or non-integer value in either field
- **THEN** the config resolution reports a config error through the existing config-schema pattern
