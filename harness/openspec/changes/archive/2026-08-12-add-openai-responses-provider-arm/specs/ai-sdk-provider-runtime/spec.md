# ai-sdk-provider-runtime Delta

## MODIFIED Requirements

### Requirement: The provider configuration path is a front-door export

The package's curated barrel MUST export the provider configuration surface: the configuration union (`AiSdkProviderConfig`, discriminated over the `anthropic`, `openai`, and `openai-compatible` kinds, carrying endpoint/key/model) and the factory that realizes it into a `ChatProvider` (`createConfiguredAiSdkProvider`). An embedder MUST be able to construct a provider of each kind without a package-internal subpath import. The existing `createAnthropicProvider` convenience wrapper MUST stay exported and behaviorally unchanged.

The exported surface MUST document the construction contract. The wire model is bound at construction, because `ChatRequest` carries no model field. Thus an embedder that runs distinct models on distinct seats builds one provider instance per model, over one shared connection configuration.

#### Scenario: An embedder constructs an openai-compatible provider through the front door

- **WHEN** an embedder imports the configuration union and factory from the package root and
  calls the factory with `{ kind: "openai-compatible", name, baseURL, apiKey, model }`
- **THEN** it receives a `ChatProvider` for that endpoint and model, with no deep-subpath import
  required

#### Scenario: An embedder constructs an anthropic provider through the front door

- **WHEN** an embedder calls the factory with `{ kind: "anthropic", baseURL, apiKey, model }`
- **THEN** it receives a `ChatProvider` equivalent to one built through `createAnthropicProvider`
  with the same endpoint, key, and model

#### Scenario: An embedder constructs an openai provider through the front door

- **WHEN** an embedder calls the factory with `{ kind: "openai", apiKey, model }`
- **THEN** it receives a `ChatProvider` over the official `@ai-sdk/openai` package, with no
  deep-subpath import required

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

Each arm of `AiSdkProviderConfig` MUST accept an optional `requestTimeoutMs` field. When the field is absent, the provider behavior MUST stay identical to the behavior before this change.

#### Scenario: The field is absent

- **WHEN** a provider is constructed without `requestTimeoutMs`
- **THEN** no guard timer is armed and no fetch wrapper for the guard is installed

### Requirement: The retry count of the envelope is configurable

Each arm of `AiSdkProviderConfig` MUST accept an optional `maxRetries` field. The retry envelope MUST use the value as its retry limit. An absent field MUST keep the current limit of 10.

#### Scenario: A configured count bounds the retries

- **WHEN** a provider with `maxRetries: 2` meets three retryable failures in a row
- **THEN** the envelope stops after 2 retries and surfaces the failure

#### Scenario: An absent count keeps the default

- **WHEN** a provider is constructed without `maxRetries`
- **THEN** the envelope retries up to 10 times, as before

### Requirement: Provider metadata is preserved through the AI SDK boundary

The provider runtime MUST preserve the provider-specific metadata that continuation correctness requires. This includes the signed Anthropic thinking and cache metadata, and the encrypted reasoning content of the `openai` arm. Provider metadata MUST stay provider-scoped. The harness MUST NOT reinterpret it as a generic Cortex message field.

#### Scenario: Signed Anthropic metadata is stored provider-scoped

- **WHEN** an Anthropic-backed AI SDK response includes signed reasoning/cache metadata required for continuation
- **THEN** the stored AI SDK model message envelope retains that metadata in provider-scoped fields

#### Scenario: Encrypted openai reasoning survives the storage round-trip

- **WHEN** an `openai`-arm response carries encrypted reasoning content on a reasoning part
- **THEN** the stored envelope retains it in provider-scoped fields, and a later turn replays it to the wire

## ADDED Requirements

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

The arm MUST merge `providerOptions.openai.store` into every model call. The default value MUST be `false`. An optional `store` field on the config MUST override the default. The arm MUST NOT leave the field unset. An unset value makes the package emit `item_reference` entries, and such a reference fails for an unstored item.

The `store` field MUST carry a `NOTICE` documentation comment. The comment MUST record the retention meaning of the value, the reference hazard of an unset value, the stateless reasoning path, and the one-mode-per-thread rule.

#### Scenario: The default request carries store false

- **WHEN** an `openai` arm without a `store` config runs a call
- **THEN** the request options carry `store: false`

#### Scenario: A config override carries store true

- **WHEN** an `openai` arm with `store: true` runs a call
- **THEN** the request options carry `store: true`

#### Scenario: The merge keeps the other request options

- **WHEN** a call already carries other provider options, for example the cache namespace
- **THEN** the merged options keep them intact beside the `store` value
