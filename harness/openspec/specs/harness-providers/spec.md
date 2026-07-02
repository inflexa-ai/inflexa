# harness-providers Specification

## Purpose

Define the harness's LLM and embedding provider seam — the narrow,
vendor-neutral interfaces (`ChatProvider`, `EmbeddingProvider`) through
which all model traffic flows. Each call carries an `AgentSession`, resolves
optional call-attribution headers through an injected `ResolveBilling` seam,
runs over the AI SDK language-model provider runtime, and classifies provider
failures.

**AI SDK `ModelMessage` is the harness's lingua franca.** The provider seam is
backed by AI SDK-compatible language models supplied by the embedder (see the
ai-sdk-provider-runtime spec); thread history stores AI SDK model-message
envelopes (see the ai-sdk-message-storage spec). Signed provider metadata
required for continuation (e.g. Anthropic signed thinking/cache metadata) rides
provider-scoped in AI SDK provider metadata fields and is preserved through
storage and replay.

**The provider owns the output-token cap.** `ChatRequest` does not expose
`max_tokens` — the provider sets the upstream cap from the model's true ceiling
(`maxOutputTokens(model)`). The loop never picks a cap; it recovers from any
residual truncation (see the harness-agent-loop spec).

Both `chat` and `embed` return a `ResultAsync` over the `ProviderError` union —
a provider failure is a value in the error channel, never a thrown exception.
The sole thrown control-flow exception is a client abort, re-raised verbatim
outside the Result channel.

## Requirements

### Requirement: The provider owns the per-model output-token cap

The provider SHALL set the upstream `max_tokens` from the model's ceiling (`maxOutputTokens`), not the caller; `ChatRequest` SHALL NOT expose `max_tokens`.

#### Scenario: max_tokens is not a caller-supplied field

- **GIVEN** the `ChatRequest` type
- **WHEN** a caller assembles a request
- **THEN** `max_tokens` is absent from the type, and the provider supplies it from `maxOutputTokens(model)`

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

### Requirement: Attribution headers are resolved from the Session

The provider SHALL resolve the attribution map via the injected `resolveBilling(session)`, then spread the returned headers onto the upstream request. The OSS/local resolver returns `{}`. Core SHALL NOT read host-specific auth fields or require a gateway; embedders that need attribution provide it behind the seam.

#### Scenario: Attribution comes from the resolver, not the session

- **GIVEN** a `RequestSession` and a resolved attribution map returned by `resolveBilling`
- **WHEN** the provider makes a request
- **THEN** the provider includes the resolver's headers
- **AND** the session itself contains no resolved header map

#### Scenario: No-op resolver emits no headers

- **GIVEN** `createNoopBillingResolver`
- **WHEN** a provider call resolves attribution
- **THEN** the returned header map is empty

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
