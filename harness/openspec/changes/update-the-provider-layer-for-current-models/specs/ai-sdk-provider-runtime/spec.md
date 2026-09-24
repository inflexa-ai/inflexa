## MODIFIED Requirements

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

## ADDED Requirements

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

The arm MUST send the mode as `providerOptions.anthropic.thinking.blockBinding.prefixMismatchBehavior`, in the form
without a `type`. The package then adds the beta header `thinking-binding-controls-2026-08-01`.

The arm MUST send the binding only on a request that runs with thinking. The binding MUST NOT change whether a request
runs with thinking. A request that runs without thinking MUST carry no `thinking` object from the harness.

#### Scenario: The default mode binds the thinking blocks

- **GIVEN** an `anthropic` arm without `thinkingBinding`, bound to `claude-opus-5-5`
- **WHEN** it runs a call
- **THEN** the request body carries `thinking.block_binding.prefix_mismatch_behavior: "drop_block"`
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

The provider MUST make a session key from the `AgentSession` of each call. The key MUST come from the first rule that
applies:

1. A run frame with a step gives `<analysisId>:<runId>:<stepId>`.
2. A run frame without a step gives `<analysisId>:<runId>`.
3. A scope with a thread gives `<analysisId>:<threadId>`.
4. Else, the key is `<analysisId>`.

The run frame comes first, because a run that a chat starts can carry the thread of that chat in its scope. The steps of
that run must not share the key of the chat. The step key spreads the parallel steps of one run across the accounts of a
gateway. Each step keeps its later calls on its account, for example the step summary.

The key MUST hold only identifiers. The key goes to the vendor, thus it MUST NOT hold a name, an address, or the
`identity` of the session. The key reads only the scope and the run frame. `forSubAgent` changes only the provenance,
thus a sub-agent sends the key of its parent.

The `anthropic` arm MUST send the key as `providerOptions.anthropic.metadata.userId`. The `openai` arm MUST send the key
as `providerOptions.openai.promptCacheKey`. The `openai-compatible` arm has no standard field, thus it MUST send no key.

The harness MUST NOT send the key as a request header, for example `X-Session-ID`. Such a header is a convention of one
gateway. A host can add it through `resolveRequestHeaders`, which gets the session.

#### Scenario: A step call carries the step key

- **GIVEN** a `RunSession` with the `analysisId` `a1`, the `runId` `r1`, and the `stepId` `s1`
- **WHEN** an `anthropic` arm runs a call under that session
- **THEN** the request body carries `metadata.user_id: "a1:r1:s1"`

#### Scenario: A run that a chat started does not share the chat key

- **GIVEN** a `RunSession` whose scope carries the `threadId` `t1`, and whose run frame carries the `runId` `r1` and no step
- **WHEN** a provider runs a call under that session
- **THEN** the session key is `a1:r1`

#### Scenario: A chat call carries the thread key

- **GIVEN** a `RequestSession` whose scope carries the `analysisId` `a1` and the `threadId` `t1`
- **WHEN** an `openai` arm runs a call under that session
- **THEN** the request body carries `prompt_cache_key: "a1:t1"`

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
