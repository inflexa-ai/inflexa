## MODIFIED Requirements

### Requirement: Provider failures are returned as a classified ProviderError value

A provider failure from the AI SDK runtime SHALL be returned in the harness error channel as a `ProviderError` in the discriminated union `{ type: "auth" } | { type: "budget" } | { type: "tenant-blocked" } | { type: "provider" }`, never as an unclassified SDK exception. Classification SHALL preserve the existing retryability semantics: auth, budget, and tenant-blocked are not retryable, transient rate-limit/5xx/connection failures are retryable provider failures, other concrete 4xx failures are non-retryable provider failures. A provider `401` — read from the failure itself or from anywhere on its `cause` chain — SHALL classify as `auth`, and the wrapped `auth` message SHALL name the credential as the broken thing (expired, revoked, or absent), never the request. Classification SHALL key on the HTTP status only, never on provider message text. A client abort SHALL be re-thrown verbatim rather than classified.

Every variant's `message` SHALL be self-describing, naming the workload it failed under and — when a status was extractable from the failure or its `cause` chain — the HTTP status, before the underlying detail. The `provider` variant SHALL NOT be an exception to this: forwarding an SDK message verbatim is not permitted, because the AI SDK falls back to the bare HTTP reason phrase (`response.statusText`) whenever an error body does not parse against the configured provider's error schema, and a bare reason phrase identifies neither the call nor the cause.

When the failure carries a captured provider response body, the `message` SHALL include a single-lined excerpt of it bounded at 120 characters. The bound SHALL be applied at composition time rather than left to a downstream consumer's truncation, and the composition SHALL order workload and status ahead of the excerpt so that any downstream truncation removes the least diagnostic content first. The 120-character bound is chosen against the tightest downstream consumer, which truncates the whole line at 200, so that the excerpt can never evict the workload and status preceding it.

Message composition SHALL happen strictly after classification and SHALL NOT feed back into it, preserving the status-only classification rule above.

#### Scenario: An expired credential 401 is a non-retryable auth error

- **GIVEN** a provider 401 response (e.g. the local proxy's provider OAuth credential expired and refresh failed)
- **WHEN** the failure is classified
- **THEN** the `ProviderError` has `type: "auth"` and `retryable: false`, and its message names the credential rather than the request

#### Scenario: A 401 nested on the cause chain still classifies as auth

- **GIVEN** an `AI_APICallError` wrapper whose `cause` carries `statusCode: 401`
- **WHEN** the failure is classified
- **THEN** the `ProviderError` has `type: "auth"` and `retryable: false`

#### Scenario: A budget error is a non-retryable ProviderError value

- **GIVEN** a budget failure from the configured AI SDK provider
- **WHEN** the model call runs
- **THEN** it resolves to an `err` whose `ProviderError` has `type: "budget"` and `retryable: false`

#### Scenario: A blocked tenant maps to tenant-blocked

- **GIVEN** a tenant authorization failure from the configured AI SDK provider
- **WHEN** the failure is classified
- **THEN** the `ProviderError` has `type: "tenant-blocked"` and `retryable: false`

#### Scenario: A transient upstream error is retryable

- **GIVEN** a provider 503 response
- **WHEN** the failure is classified
- **THEN** the `ProviderError` has `type: "provider"` with `retryable: true`

#### Scenario: A non-conforming 400 body does not degrade to a reason phrase

- **GIVEN** a provider 400 whose response body does not parse against the configured provider's error schema, so the SDK error's message is the bare reason phrase `Bad Request`
- **WHEN** the failure is classified
- **THEN** the `ProviderError` has `type: "provider"` and `retryable: false`
- **AND** its message SHALL name the workload and the status `400`, and SHALL NOT be the bare reason phrase alone

#### Scenario: A captured response body is preserved in the message

- **GIVEN** a provider failure whose captured response body explains the rejection
- **WHEN** the failure is classified
- **THEN** the message SHALL carry a bounded, single-lined excerpt of that body

#### Scenario: An empty reason phrase still yields an identifying message

- **GIVEN** a provider failure over a transport that supplies no reason phrase, so the SDK error message is empty
- **WHEN** the failure is classified
- **THEN** the message SHALL still name the workload and the status, rather than resolving to an empty or generic string

#### Scenario: Message composition does not alter classification

- **GIVEN** two provider failures with the same HTTP status and different response bodies
- **WHEN** both are classified
- **THEN** they SHALL receive the same `type` and `retryable`, differing only in `message`

#### Scenario: A client abort escapes the error channel

- **GIVEN** an aborted `AbortSignal` during a model call
- **WHEN** the SDK raises the abort
- **THEN** the call re-throws it verbatim rather than returning an `err(ProviderError)`
