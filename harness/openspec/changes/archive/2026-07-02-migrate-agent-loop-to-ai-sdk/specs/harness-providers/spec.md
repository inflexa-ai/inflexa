## REMOVED Requirements

### Requirement: Anthropic message shape is the provider lingua franca

**Reason**: The harness is migrating provider and model-message semantics to AI SDK so provider support is not limited by a harness-owned Anthropic normalization layer.

**Migration**: Use the AI SDK language-model provider runtime and store AI SDK `ModelMessage` envelopes for thread history.

### Requirement: Anthropic content blocks round-trip verbatim

**Reason**: Signed provider metadata must still be preserved, but it is no longer represented as Anthropic SDK content blocks in the harness provider contract.

**Migration**: Preserve required signed provider metadata in AI SDK provider metadata fields and validate it through the AI SDK message envelope.

## MODIFIED Requirements

### Requirement: Chat provider exposes streaming and non-streaming entry points

The harness chat provider seam SHALL expose AI SDK-backed non-streaming and streaming entry points suitable for both request-path chat and durable workflow loops. Non-streaming execution SHALL return a complete AI SDK model response/transcript value usable by the loop, and streaming execution SHALL emit text deltas plus a terminal response value. Both entry points SHALL use the same AI SDK-compatible language model and SHALL preserve provider metadata needed for continuation.

#### Scenario: Non-streaming chat returns a complete AI SDK response

- **GIVEN** a fake AI SDK language model emitting text and a final response
- **WHEN** the non-streaming provider entry point is called
- **THEN** it resolves to a complete response whose AI SDK model message content can be appended to the loop transcript

#### Scenario: Streaming chat yields deltas then one terminal response

- **GIVEN** the same fake AI SDK language model
- **WHEN** the streaming provider entry point is consumed to completion
- **THEN** it yields text deltas followed by exactly one terminal event carrying the complete response

### Requirement: Every provider call requires a Session

AI SDK chat/model calls and `EmbeddingProvider.embed` SHALL each require an `AgentSession` parameter, so the same provider runtime serves a live request and a durable workflow run. No code path SHALL issue an LLM or embedding call without a session. The session SHALL NOT carry resolved attribution headers; those SHALL be resolved at the call site through the injected `ResolveBilling` seam and applied by the provider wrapper.

#### Scenario: A provider call without a session does not type-check

- **GIVEN** the provider interface
- **WHEN** a caller invokes a model call without an `AgentSession` argument
- **THEN** the code fails to compile

#### Scenario: Either bundle satisfies the provider seam

- **GIVEN** the provider interface taking an `AgentSession`
- **WHEN** a `RequestSession` or a `RunSession` is passed
- **THEN** both type-check, and run/step attribution is available only when the session carries a `RunFrame`

#### Scenario: A provider is constructed with an injected resolver

- **GIVEN** the provider factory
- **WHEN** a provider is constructed
- **THEN** it requires a `resolveBilling(session) => Promise<Record<string,string>>` dependency, and tests inject a fake returning a static map

### Requirement: Provider failures are returned as a classified ProviderError value

A provider failure from the AI SDK runtime SHALL be returned in the harness error channel as a `ProviderError` in the discriminated union `{ type: "budget" } | { type: "tenant-blocked" } | { type: "provider" }`, never as an unclassified SDK exception. Classification SHALL preserve the existing retryability semantics: budget and tenant-blocked are not retryable, transient rate-limit/5xx/connection failures are retryable provider failures, other concrete 4xx failures are non-retryable provider failures. A client abort SHALL be re-thrown verbatim rather than classified.

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

#### Scenario: A client abort escapes the error channel

- **GIVEN** an aborted `AbortSignal` during a model call
- **WHEN** the SDK raises the abort
- **THEN** the call re-throws it verbatim rather than returning an `err(ProviderError)`
