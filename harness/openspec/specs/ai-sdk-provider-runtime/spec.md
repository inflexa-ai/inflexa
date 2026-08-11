# ai-sdk-provider-runtime Specification

## Purpose

Define the AI SDK-backed provider runtime: embedders supply AI SDK-compatible language models (instances or endpoint/key/model configuration) at runtime assembly, the harness enforces tool-call capability before running tool-requiring agents, provider-specific metadata stays provider-scoped through the AI SDK boundary, and provider failures map into the classified harness `ProviderError` union.

## Requirements

### Requirement: Embedders provide AI SDK-compatible language models dynamically

The harness SHALL accept AI SDK-compatible language model instances or endpoint/key/model configuration from the embedder at runtime assembly. The harness SHALL NOT hard-code a single provider family as the only model path.

#### Scenario: CLI supplies a remote endpoint

- **WHEN** the CLI constructs the harness runtime with an allowed remote endpoint, key, and model id
- **THEN** the harness uses the supplied AI SDK-compatible language model for agent execution

#### Scenario: Embedder supplies a self-hosted endpoint

- **WHEN** an embedder supplies an allowed self-hosted endpoint through the provider configuration
- **THEN** the harness can run agents through that endpoint if its model capabilities satisfy the agent requirements

### Requirement: Tool-required agents enforce tool-call capable providers

An agent that requires tools SHALL run only with a provider/model configuration whose capabilities indicate mature tool-call support. The harness SHALL fail before execution when a selected provider cannot perform required tool calls.

#### Scenario: Tool-incompatible model is rejected

- **WHEN** an agent with tools is started with a model configuration that does not support tool calling
- **THEN** the harness rejects the run before the first model call

### Requirement: Provider metadata is preserved through the AI SDK boundary

The provider runtime SHALL preserve provider-specific metadata that is required for continuation correctness, including signed Anthropic thinking/cache metadata when AI SDK exposes it. Provider metadata SHALL remain provider-scoped; the harness SHALL NOT reinterpret it as generic Cortex message fields.

#### Scenario: Signed Anthropic metadata is stored provider-scoped

- **WHEN** an Anthropic-backed AI SDK response includes signed reasoning/cache metadata required for continuation
- **THEN** the stored AI SDK model message envelope retains that metadata in provider-scoped fields

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

### Requirement: The provider configuration path is a front-door export

The package's curated barrel SHALL export the provider configuration surface: the configuration
union (`AiSdkProviderConfig`, discriminated over the `anthropic` and `openai-compatible` kinds,
carrying endpoint/key/model) and the factory that realizes it into a `ChatProvider`
(`createConfiguredAiSdkProvider`). An embedder SHALL be able to construct a provider of either
kind without importing package-internal subpaths. The existing `createAnthropicProvider`
convenience wrapper SHALL remain exported and behaviorally unchanged.

The exported surface SHALL document the construction contract: the wire model is bound at
construction (`ChatRequest` carries no model field), so an embedder that runs distinct models on
distinct seats builds one provider instance per model, over one shared connection configuration.

#### Scenario: An embedder constructs an openai-compatible provider via the front door

- **WHEN** an embedder imports the configuration union and factory from the package root and
  calls the factory with `{ kind: "openai-compatible", name, baseURL, apiKey, model }`
- **THEN** it receives a `ChatProvider` for that endpoint and model, with no deep-subpath import
  required

#### Scenario: An embedder constructs an anthropic provider via the front door

- **WHEN** an embedder calls the factory with `{ kind: "anthropic", baseURL, apiKey, model }`
- **THEN** it receives a `ChatProvider` equivalent to one built through `createAnthropicProvider`
  with the same endpoint, key, and model

#### Scenario: Existing embedder imports keep working

- **WHEN** an embedder built against the prior barrel imports `createAnthropicProvider` from the
  package root
- **THEN** the import resolves and behaves exactly as before

#### Scenario: Two seat models over one connection are two provider instances

- **WHEN** an embedder needs a conversation seat on model A and a sandbox seat on model B against
  the same endpoint and key
- **THEN** it constructs two providers from the same connection configuration differing only in
  `model`, and each seat's requests carry its own bound model

### Requirement: Provider configuration accepts a request timeout

Both arms of `AiSdkProviderConfig` MUST accept an optional `requestTimeoutMs` field. When the field is absent, the provider behavior MUST stay identical to the behavior before this change.

#### Scenario: The field is absent

- **WHEN** a provider is constructed without `requestTimeoutMs`
- **THEN** no guard timer is armed and no fetch wrapper for the guard is installed

### Requirement: The provider bounds each silent interval of an attempt

When `requestTimeoutMs` is set, the provider MUST bound each silent interval of a request attempt. A silent interval is the wait until the response starts, or a gap between two content chunks. The response-start wait MUST be bounded by the provider's own guard timer, and the timer MUST clear when the headers arrive. Each content gap of a streamed body MUST be bounded through the SDK `timeout` setting with `chunkMs`. A chunk that carries no content, for example a keep-alive comment, MUST NOT reset the gap bound. The guard MUST compose with the abort signal of the caller, and the caller signal MUST keep its normal effect. The guard MUST apply per attempt, so each retry of the envelope receives a full window. The total length of a stream with steady content MUST NOT trip any bound.

#### Scenario: A slow response start trips the guard

- **GIVEN** a provider with `requestTimeoutMs` set
- **WHEN** the endpoint does not start its response within the window
- **THEN** the attempt is aborted with a typed request-timeout reason

#### Scenario: A steady stream does not trip the guard

- **GIVEN** a streamed response whose headers arrived within the window
- **WHEN** the stream runs longer than `requestTimeoutMs` with each content gap under the window
- **THEN** no bound aborts the stream

#### Scenario: A stalled stream trips the SDK bound

- **GIVEN** a streamed response whose headers arrived within the window
- **WHEN** no content chunk arrives for `requestTimeoutMs`
- **THEN** the attempt is aborted through the SDK chunk bound

#### Scenario: A keep-alive does not feed the stream

- **GIVEN** a streamed response that emits keep-alive comments without content
- **WHEN** no content chunk arrives for `requestTimeoutMs`
- **THEN** the attempt is aborted, because a keep-alive does not reset the gap bound

#### Scenario: The caller abort still cancels

- **GIVEN** a provider with `requestTimeoutMs` set
- **WHEN** the abort signal of the caller fires before the window closes
- **THEN** the request is canceled as a caller abort, not as a timeout

### Requirement: A guard expiry classifies as a retryable provider timeout

A guard abort MUST surface as a provider error with `retryable: true`, and its message MUST name the configured value. An error named `TimeoutError`, the DOMException that the SDK `timeout` setting raises, MUST classify the same way. The classification MUST NOT treat either as a caller cancellation. The envelope MUST retry them under the same policy as a connection error, within its coverage. For a stream that coverage is the establishment window, so a failure after the first delta propagates un-retried. When the abort signal of the caller is aborted, the envelope MUST rethrow without a retry. Thus a wall-clock expiry that rides the caller signal never loops.

#### Scenario: The envelope retries a guard expiry

- **WHEN** the guard aborts an attempt and the retry limit is not reached
- **THEN** the envelope makes another attempt with a fresh window

#### Scenario: The envelope retries an SDK chunk timeout at establishment

- **WHEN** the SDK chunk bound aborts a stream before its first delta and the retry limit is not reached
- **THEN** the envelope makes another attempt with a fresh window

#### Scenario: A mid-stream chunk timeout propagates

- **WHEN** the SDK chunk bound aborts a stream after its first delta
- **THEN** the provider error propagates without an envelope retry, per the establishment coverage of a stream

#### Scenario: A caller-signal expiry does not loop

- **GIVEN** a caller signal that a wall-clock guard aborted with a `TimeoutError` reason
- **WHEN** the provider call fails
- **THEN** the envelope rethrows without a retry

#### Scenario: The retry limit ends the call

- **WHEN** the guard aborts an attempt and the retry limit is reached
- **THEN** the provider call fails with the timeout error

### Requirement: The retry count of the envelope is configurable

Both arms of `AiSdkProviderConfig` MUST accept an optional `maxRetries` field. The retry envelope MUST use the value as its retry limit. An absent field MUST keep the current limit of 10.

#### Scenario: A configured count bounds the retries

- **WHEN** a provider with `maxRetries: 2` meets three retryable failures in a row
- **THEN** the envelope stops after 2 retries and surfaces the failure

#### Scenario: An absent count keeps the default

- **WHEN** a provider is constructed without `maxRetries`
- **THEN** the envelope retries up to 10 times, as before

### Requirement: The harness supplies the Bun transport lift

When `requestTimeoutMs` is set, the fetch wrapper MUST add `timeout: false` to the fetch init. The key is a Bun extension: it lifts the 300-second idle cut under Bun, and it is inert under Node. The documentation of `requestTimeoutMs` MUST state the Node caveat: the undici floor stays, and a Node embedder above 300 seconds supplies a dispatcher-raised fetch. When the field is absent, the wrapper MUST NOT be installed, and the init MUST stay untouched.

#### Scenario: A Bun embedder needs no composition work

- **GIVEN** a Bun host with `requestTimeoutMs` above 300 seconds and no custom fetch
- **WHEN** the endpoint starts its response after 300 seconds but within the window
- **THEN** the request completes, because the guard lifted the idle cut

#### Scenario: An absent field touches nothing

- **WHEN** a provider is constructed without `requestTimeoutMs`
- **THEN** no wrapper is installed and no `timeout` key is added to any fetch init
