# harness-providers Specification

## Purpose

Define the harness's LLM and embedding provider seam — the narrow,
vendor-neutral interfaces (`ChatProvider`, `EmbeddingProvider`) through
which all model traffic flows. Each call carries an `AgentSession`, resolves
optional call-attribution headers through an injected `ResolveBilling` seam,
preserves Anthropic message shape end-to-end, and classifies provider failures.

**Anthropic message shape is the harness's lingua franca.** `ChatProvider.chat`
returns the Anthropic SDK's `Message`; the loop appends it, memory persists it
as JSONB, and the DBOS step cache stores it as a serialized string. The decisive
reason is signed `thinking` blocks: replay correctness rests on
`{ type: "thinking", thinking, signature }` round-tripping byte-for-byte through
a JSON step cache, which Anthropic-native achieves trivially and a normalized
intermediate layer would put at risk. A non-Anthropic provider (e.g. an OpenAI
adapter) lives in its own file and adapts *into* Anthropic shape — translating
the request out, the response back, dropping features with no Anthropic analog
rather than shoe-horning them, and normalizing its truncation signal into the
single Anthropic `stop_reason: "max_tokens"` (`mapOpenAiFinishReason` maps
`length → max_tokens`). Building a normalization layer for one adapter buys
nothing; the second adapter is the first real seam.

**The provider owns the output-token cap.** `ChatRequest` is the Anthropic
request minus `model`, `stream`, and `max_tokens` — all provider-owned. The
Anthropic provider forces streaming on and sets `max_tokens` from the model's
true ceiling (`maxOutputTokens(model)`), since the API requires the field. The
loop never picks a cap; it recovers from any residual truncation (see the
harness-agent-loop spec).

Both `chat` and `embed` return a `ResultAsync` over the `ProviderError` union —
a provider failure is a value in the error channel, never a thrown exception.
The sole thrown control-flow exception is a client abort, re-raised verbatim
outside the Result channel.

## Requirements

### Requirement: Anthropic message shape is the provider lingua franca

`ChatProvider` SHALL return the Anthropic SDK's `Message`, and `ChatRequest` SHALL be the Anthropic request shape minus the provider-owned `model`, `stream`, and `max_tokens` fields. A non-Anthropic provider SHALL adapt into this shape inside its own file, mapping its truncation signal to `stop_reason: "max_tokens"` so the loop branches on one signal across providers.

#### Scenario: A non-Anthropic length finish normalizes to max_tokens

- **WHEN** an upstream `finish_reason: "length"` is mapped via `mapOpenAiFinishReason`
- **THEN** the resulting Anthropic `stop_reason` is `"max_tokens"`

### Requirement: The provider owns the per-model output-token cap

The provider SHALL set the upstream `max_tokens` from the model's ceiling (`maxOutputTokens`), not the caller; `ChatRequest` SHALL NOT expose `max_tokens`.

#### Scenario: max_tokens is not a caller-supplied field

- **GIVEN** the `ChatRequest` type
- **WHEN** a caller assembles a request
- **THEN** `max_tokens` is absent from the type, and the provider supplies it from `maxOutputTokens(model)`

### Requirement: Chat provider exposes streaming and non-streaming entry points

The `ChatProvider` interface SHALL expose `chat(req, session, signal?)` returning a `ResultAsync<Message, ProviderError>`, and `chatStream(req, session, signal?)` returning an async iterable of `ChatStreamEvent`. Both SHALL issue streaming wire calls to the upstream provider; `chat` SHALL collapse the stream to the assembled `Message`.

#### Scenario: Non-streaming chat returns a complete message

- **GIVEN** a fake provider stream emitting text chunks and a final message
- **WHEN** `chat` is called
- **THEN** it resolves to an `ok` carrying the assembled `Message` with all content blocks present

#### Scenario: Streaming chat yields deltas then one terminal done event

- **GIVEN** the same fake provider stream
- **WHEN** `chatStream` is consumed to completion
- **THEN** it yields `text-delta` events followed by exactly one `done` event carrying the assembled `Message`

### Requirement: Every provider call requires a Session

`ChatProvider.chat`, `ChatProvider.chatStream`, and `EmbeddingProvider.embed` SHALL each require an `AgentSession` parameter — the conduit identity view that both `RequestSession` and `RunSession` satisfy (see `harness-session-model`), so the same provider serves a live request and a durable workflow run. No code path SHALL issue an LLM or embedding call without a session. The session SHALL NOT carry resolved attribution headers — those are resolved at the call site through the injected `ResolveBilling` seam.

#### Scenario: A provider call without a session does not type-check

- **GIVEN** the `ChatProvider` interface
- **WHEN** a caller invokes `chat` without an `AgentSession` argument
- **THEN** the code fails to compile

#### Scenario: Either bundle satisfies the provider seam

- **GIVEN** the `ChatProvider` interface taking an `AgentSession`
- **WHEN** a `RequestSession` or a `RunSession` is passed
- **THEN** both type-check, and run/step attribution is available only when the session carries a `RunFrame`

#### Scenario: A provider is constructed with an injected resolver

- **GIVEN** the provider factory
- **WHEN** a provider is constructed
- **THEN** it requires a `resolveBilling(session) => Promise<Record<string,string>>` dependency, and tests inject a fake returning a static map

### Requirement: Anthropic content blocks round-trip verbatim

A `Message` returned by a provider SHALL preserve Anthropic content blocks verbatim, including `thinking` blocks with their `signature` field byte-for-byte.

#### Scenario: A thinking block signature survives the provider

- **GIVEN** a provider stream whose final message contains a `thinking` block with a signature
- **WHEN** `chat` assembles the message
- **THEN** the returned `thinking` block carries the identical `signature` string

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

A provider failure SHALL be returned in the `ResultAsync` error channel as a `ProviderError` — the discriminated union `{ type: "budget" } | { type: "tenant-blocked" } | { type: "provider" }` — never a thrown typed error and never a dedicated `BudgetExceededError` class. `classifyProviderError` SHALL key off the `cause` chain's HTTP status: `402 → budget` (not retryable), `403 → tenant-blocked` (not retryable), `429`/`5xx`/connection errors `→ provider` (retryable), and any other concrete `4xx` `→ provider` (not retryable). A client abort SHALL be re-thrown verbatim rather than classified.

#### Scenario: A budget error is a non-retryable ProviderError value

- **GIVEN** a 402 response from the configured provider endpoint
- **WHEN** `chat` runs
- **THEN** it resolves to an `err` whose `ProviderError` has `type: "budget"` and `retryable: false`

#### Scenario: A blocked tenant maps to tenant-blocked

- **GIVEN** a 403 response from the configured provider endpoint
- **WHEN** the failure is classified
- **THEN** the `ProviderError` has `type: "tenant-blocked"` and `retryable: false`

#### Scenario: A transient upstream error is retryable

- **GIVEN** a provider 503 response
- **WHEN** the failure is classified
- **THEN** the `ProviderError` has `type: "provider"` with `retryable: true`

#### Scenario: A client abort escapes the error channel

- **GIVEN** an aborted `AbortSignal` during a `chat` call
- **WHEN** the SDK raises the abort
- **THEN** `chat` re-throws it verbatim rather than returning an `err(ProviderError)`
