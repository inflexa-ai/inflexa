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

The provider runtime MUST preserve the provider-specific metadata that continuation correctness requires. This includes the signed Anthropic thinking and cache metadata, and the encrypted reasoning content of the `openai` arm. Provider metadata MUST stay provider-scoped. The harness MUST NOT reinterpret it as a generic Cortex message field.

#### Scenario: Signed Anthropic metadata is stored provider-scoped

- **WHEN** an Anthropic-backed AI SDK response includes signed reasoning/cache metadata required for continuation
- **THEN** the stored AI SDK model message envelope retains that metadata in provider-scoped fields

#### Scenario: Encrypted openai reasoning survives the storage round-trip

- **WHEN** an `openai`-arm response carries encrypted reasoning content on a reasoning part
- **THEN** the stored envelope retains it in provider-scoped fields, and a later turn replays it to the wire

### Requirement: Provider failures remain classified values

AI SDK provider calls MUST map provider failures into the harness `ProviderError` union with the kinds `auth`, `suspend`, and `provider`. A status in the `suspendOn` map of the provider MUST map to a non-retryable `suspend` error with the status and the reason of the map. A 401 SHALL map to a non-retryable `auth` error whose message names the credential, so an embedder can surface a re-authentication remedy. Client abort SHALL continue to propagate as abort control flow rather than as a classified provider error.

#### Scenario: A mapped status stays non-retryable

- **WHEN** the configured AI SDK provider answers with a status in its `suspendOn` map
- **THEN** the harness maps the failure to a non-retryable `ProviderError` with `type: "suspend"`, the status, and the reason of the map

#### Scenario: An unmapped 403 is a provider error

- **WHEN** the configured AI SDK provider answers `403`, and its `suspendOn` map does not hold `403`
- **THEN** the harness maps the failure to a non-retryable `ProviderError` with `type: "provider"`

#### Scenario: Credential failure maps to auth

- **WHEN** the configured AI SDK provider answers 401 because the credential behind the call is expired, revoked, or absent
- **THEN** the harness maps it to a non-retryable `ProviderError` with `type: "auth"`

#### Scenario: Client abort escapes classification

- **WHEN** an `AbortSignal` aborts an AI SDK model call
- **THEN** the abort propagates rather than being returned as a `ProviderError`

### Requirement: The provider configuration path is a front-door export

The curated barrel of the package MUST export the provider configuration surface. The surface is the configuration
union `AiSdkProviderConfig` and the factory `createConfiguredAiSdkProvider`, which makes a `ChatProvider` from one value
of the union. The union is discriminated over the `anthropic`, `openai`, and `openai-compatible` kinds. Each arm carries
the endpoint, the key, and the model. An embedder MUST be able to make a provider of each kind without a
package-internal subpath import.

The configuration path MUST be the only factory of the barrel for a chat provider. The barrel MUST NOT export
`createAnthropicProvider` or `AnthropicProviderDeps`. The `anthropic` arm of the union makes the same provider.

The exported surface MUST document the construction contract. The wire model is bound at construction, because
`ChatRequest` carries no model field. Thus an embedder that runs different models on different seats makes one provider
instance for each model, over one shared connection configuration.

#### Scenario: An embedder constructs an openai-compatible provider through the front door

- **WHEN** an embedder imports the configuration union and the factory from the package root, and calls the factory with `{ kind: "openai-compatible", name, baseURL, apiKey, model }`
- **THEN** it receives a `ChatProvider` for that endpoint and that model, with no deep-subpath import

#### Scenario: An embedder constructs an anthropic provider through the front door

- **WHEN** an embedder calls the factory with `{ kind: "anthropic", baseURL, apiKey, model }`
- **THEN** it receives a `ChatProvider` for that endpoint and that model, with no deep-subpath import

#### Scenario: An embedder constructs an openai provider through the front door

- **WHEN** an embedder calls the factory with `{ kind: "openai", apiKey, model }`
- **THEN** it receives a `ChatProvider` over the official `@ai-sdk/openai` package, with no deep-subpath import

#### Scenario: The removed wrapper does not compile

- **WHEN** an embedder imports `createAnthropicProvider` from the package root
- **THEN** the import fails to compile
- **AND** the `anthropic` arm of `createConfiguredAiSdkProvider` makes the same provider from the same endpoint, key, and model

#### Scenario: Two seat models over one connection are two provider instances

- **WHEN** an embedder needs a conversation seat on model A and a sandbox seat on model B, against the same endpoint and the same key
- **THEN** it makes two providers from one connection configuration, with a different `model` only, and each seat sends its own bound model

### Requirement: Provider configuration accepts a request timeout

Each arm of `AiSdkProviderConfig` MUST accept an optional `requestTimeoutMs` field. When the field is absent, the provider behavior MUST stay identical to the behavior before this change.

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

Each arm of `AiSdkProviderConfig` MUST accept an optional `maxRetries` field. The retry envelope MUST use the value as its retry limit. An absent field MUST keep the current limit of 10.

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

### Requirement: The openai arm binds the Responses path of the official package

The `openai` kind MUST realize its model over `@ai-sdk/openai` with an explicit `provider.responses(model)` binding. The config alone MUST select the arm. The factory MUST NOT inspect a URL to pick a kind. An absent `baseURL` MUST mean the default OpenAI endpoint.

#### Scenario: The config selects the arm

- **WHEN** an embedder calls the factory with `{ kind: "openai", apiKey, model }`
- **THEN** the provider binds the Responses path of the official package for that model

#### Scenario: A chat-completions endpoint fails loud

- **WHEN** an `openai` arm points at a `baseURL` that answers with a chat-completions body
- **THEN** the call surfaces a classified provider error, not a silent fallback

### Requirement: The openai arm sets the image capability by endpoint

When `baseURL` is absent and the config gives no value, the arm MUST set `imageToolResults: true`. When `baseURL` is present and the config gives no value, the arm MUST leave the capability absent. A config value MUST override the default in both directions.

#### Scenario: The default endpoint carries the picture

- **WHEN** an `openai` arm is constructed without `baseURL` and without a capability config
- **THEN** the provider advertises `imageToolResults: true`, and the loop sends a tool picture as an image block

#### Scenario: A custom endpoint does not claim the capability

- **WHEN** an `openai` arm is constructed with a `baseURL` and without a capability config
- **THEN** the capability is absent, and the loop drops a tool picture with a warn record

#### Scenario: The config overrides the default

- **WHEN** an `openai` arm without `baseURL` declares `imageToolResults: false`
- **THEN** the provider advertises `false`, and the loop drops the picture

### Requirement: The openai arm reports usage on the neutral fields

The arm MUST reuse the shared provider runtime, with no arm-owned usage or stream mapping. A Responses call MUST report its usage on the neutral `ChatUsage` fields: `inputTokens`, `outputTokens`, `cacheReadInputTokens`, and `reasoningTokens`. The stream path MUST yield text deltas and a terminal response through the shared pull.

#### Scenario: Cached tokens arrive on the neutral field

- **WHEN** a Responses call answers with `input_tokens_details.cached_tokens`
- **THEN** the `ChatResponse.usage` carries the count on `cacheReadInputTokens`

#### Scenario: Reasoning tokens arrive on the neutral field

- **WHEN** a Responses call answers with `output_tokens_details.reasoning_tokens`
- **THEN** the `ChatResponse.usage` carries the count on `reasoningTokens`

#### Scenario: The stream path completes through the shared pull

- **WHEN** an `openai` arm streams a turn
- **THEN** the consumer receives text deltas and one `done` event whose response carries the usage

### Requirement: The openai arm sends an explicit store value on every request

The arm MUST merge `providerOptions.openai.store` into every model call. The default value MUST be `false`. An optional
`store` field on the config MUST override the default. The arm MUST NOT leave the field unset. An unset value makes the
package emit `item_reference` entries, and such a reference fails for an item that the server did not store.

The merge MUST keep each other key of the `openai` namespace. The provider puts the session key of the call in that
namespace as `promptCacheKey`, thus the merge must not drop it.

The `store` field MUST carry a `NOTICE` documentation comment. The comment MUST record the retention meaning of the
value, the reference hazard of an unset value, the stateless reasoning path, and the one-mode-per-thread rule.

#### Scenario: The default request carries store false

- **WHEN** an `openai` arm without a `store` config runs a call
- **THEN** the request options carry `store: false`

#### Scenario: A config override carries store true

- **WHEN** an `openai` arm with `store: true` runs a call
- **THEN** the request options carry `store: true`

#### Scenario: The merge keeps the session key

- **WHEN** an `openai` arm runs a call under a session
- **THEN** the request options carry `promptCacheKey` beside the `store` value, and the merge drops neither value

### Requirement: The provider configuration carries the reasoning effort

Each arm of `AiSdkProviderConfig` MUST accept an optional `reasoning: ReasoningPolicy`. The factory MUST give the value
to the provider that it makes. The provider applies the value to each call whose request sets no `reasoning`, as the
harness-providers capability describes.

A host sets the effort of each role on the provider of that role, beside the model of that role. The harness MUST NOT
take a map from an agent identifier to an effort. The agent identifiers are internal names of the harness, and a host
must not know them.

A configured value gives the same effort to each call of one conversation. This is important, because Anthropic
discards its message cache when the top-level effort changes.

#### Scenario: A configured effort reaches the call

- **GIVEN** a provider made from `{ kind: "anthropic", baseURL, apiKey, model, reasoning: "high" }`
- **WHEN** a request without `reasoning` runs
- **THEN** the model call carries the reasoning `high`

#### Scenario: An absent effort keeps the default

- **GIVEN** a provider made from a configuration without `reasoning`
- **WHEN** a request without `reasoning` runs
- **THEN** the model call carries `DEFAULT_REASONING`, which is `xhigh`

### Requirement: The anthropic arm sends a thinking-binding mode

The `anthropic` arm of `AiSdkProviderConfig` MUST accept an optional `thinkingBinding`, with the values `drop_block`,
`error`, and `off`. The default MUST be `drop_block`. The modes have these effects:

- `drop_block`: the API drops the thinking block whose prefix does not match, and each later thinking block of that request. The request continues, and the response reports each drop in `input_transformations`.
- `error`: the API refuses the request with HTTP 400. A test against the real API uses this mode, thus a prefix change fails the test.
- `off`: the provider sends no binding. A gateway that refuses the beta header needs this mode.

The arm MUST send the mode as `providerOptions.anthropic.thinking.blockBinding.prefixMismatchBehavior`. Any
`providerOptions.anthropic.thinking` stops the thinking selection of the package. Thus the same `thinking` object MUST
also carry the `type` and the `display` that the package selects for the effort of the call. For a model that always
thinks, these are `adaptive` and `summarized` for each effort from `minimal` to `xhigh`. For `none` and
`provider-default`, the package selects no `type` and no `display`, thus the object carries the binding alone. The
package then adds the beta header `thinking-binding-controls-2026-08-01`.

The arm MUST send the binding only on a request that runs with thinking. The binding MUST NOT change whether a request
runs with thinking. A request that runs without thinking MUST carry no `thinking` object from the harness.

#### Scenario: The default mode binds the thinking blocks

- **GIVEN** an `anthropic` arm without `thinkingBinding`, bound to `claude-opus-5-5`
- **WHEN** it runs a call at the effort `xhigh`
- **THEN** the request body carries `thinking.block_binding.prefix_mismatch_behavior: "drop_block"`
- **AND** the `thinking` object also carries `type: "adaptive"` and `display: "summarized"`, as the package selects them
- **AND** the request carries the beta header `thinking-binding-controls-2026-08-01`

#### Scenario: The error mode refuses a mismatch

- **GIVEN** an `anthropic` arm with `thinkingBinding: "error"`, bound to `claude-opus-5-5`
- **WHEN** it runs a call
- **THEN** the request body carries `thinking.block_binding.prefix_mismatch_behavior: "error"`

#### Scenario: The off mode sends no binding

- **GIVEN** an `anthropic` arm with `thinkingBinding: "off"`
- **WHEN** it runs a call
- **THEN** the request body carries no `block_binding`, and the request carries no binding beta header

#### Scenario: A request without thinking carries no binding

- **GIVEN** an `anthropic` arm bound to `claude-sonnet-4-5`, and a call with the reasoning `none`
- **WHEN** it runs the call
- **THEN** the request body carries `thinking: { type: "disabled" }` from the package, and no `block_binding`

### Requirement: The provider sends a session key on each call

The provider MUST make a session key from the `AgentSession` of each call. The identifier string of the key MUST come
from the first rule that applies:

1. A run frame with a step gives `<analysisId>:<runId>:<stepId>`.
2. A run frame without a step gives `<analysisId>:<runId>`.
3. A scope with a thread gives `<analysisId>:<threadId>`.
4. Else, the string is `<analysisId>`.

The run frame comes first, because a run that a chat starts can carry the thread of that chat in its scope. The steps of
that run must not share the key of the chat. The step key spreads the parallel steps of one run across the accounts of a
gateway. Each step keeps its later calls on its account, for example the step summary.

The identifier string MUST hold only identifiers. It MUST NOT hold a name, an address, or the `identity` of the session.
It reads only the scope and the run frame. `forSubAgent` changes only the provenance, thus a sub-agent sends the key of
its parent.

The key that goes to the vendor MUST be the base64url SHA-256 digest of the identifier string, with 43 characters. The
string of a step holds three identifiers, and it has more than 64 characters. OpenAI and Azure refuse a
`prompt_cache_key` longer than 64 characters with HTTP 400, and no retry passes that error. Anthropic recommends a hash
or another opaque value for `metadata.user_id`. One string always gives one digest, thus a gateway keeps the calls of
one session on one account.

The `anthropic` arm MUST send the key as `providerOptions.anthropic.metadata.userId`. The `openai` arm MUST send the key
as `providerOptions.openai.promptCacheKey`. The `openai-compatible` arm has no standard field, thus it MUST send no key.

The harness MUST NOT send the key as a request header, for example `X-Session-ID`. Such a header is a convention of one
gateway. A host can add it through `resolveRequestHeaders`, which gets the session.

#### Scenario: A step call carries the step key

- **GIVEN** a `RunSession` with the `analysisId` `a1`, the `runId` `r1`, and the `stepId` `s1`
- **WHEN** an `anthropic` arm runs a call under that session
- **THEN** the request body carries `metadata.user_id` with the base64url SHA-256 digest of `a1:r1:s1`

#### Scenario: A run that a chat started does not share the chat key

- **GIVEN** a `RunSession` whose scope carries the `threadId` `t1`, and whose run frame carries the `runId` `r1` and no step
- **WHEN** a provider runs a call under that session
- **THEN** the identifier string of the session key is `a1:r1`

#### Scenario: A chat call carries the thread key

- **GIVEN** a `RequestSession` whose scope carries the `analysisId` `a1` and the `threadId` `t1`
- **WHEN** an `openai` arm runs a call under that session
- **THEN** the request body carries `prompt_cache_key` with the base64url SHA-256 digest of `a1:t1`

#### Scenario: The key fits the limit of the vendor

- **GIVEN** a step session whose analysis id and run id are UUIDs
- **WHEN** the provider makes the session key
- **THEN** the key has 43 characters, thus it stays within the limit of 64 characters
- **AND** the key is the same each time for that session, and different for a different step of the same run

#### Scenario: A sub-agent sends the key of its parent

- **GIVEN** a session, and the child session that `forSubAgent` derives from it
- **WHEN** a provider runs one call under each session
- **THEN** the two calls carry the same session key

#### Scenario: The openai-compatible arm sends no key

- **WHEN** an `openai-compatible` arm runs a call
- **THEN** the request body carries no session key and no `prompt_cache_key`

### Requirement: The openai-compatible arm asks for usage on a stream

The `openai-compatible` arm MUST make its model with `includeUsage: true`. The package then sends
`stream_options: { include_usage: true }` on each streamed request. The provider streams each call, and `chat` also
streams. Thus without the flag, most calls of this arm report no usage.

#### Scenario: A streamed call asks for usage

- **WHEN** an `openai-compatible` arm runs a call
- **THEN** the request body carries `stream_options.include_usage: true`
- **AND** the usage chunk of the server reaches `ChatResponse.usage`

