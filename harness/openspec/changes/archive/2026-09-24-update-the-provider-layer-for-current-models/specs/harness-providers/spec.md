## MODIFIED Requirements

### Requirement: Prompt caching is a vendor-neutral policy translated at one site

The harness MUST express prompt caching as `PromptCachePolicy`. A value of `{ ttl: "5m" | "1h" }` caches the request
prefix for that lifetime. The prefix is the tools, the system prompt, and the message history. A value of `"off"` sends
no cache directive at all.

`providers/prompt-cache.ts` MUST be the ONLY place in the harness that names a vendor for caching.
`promptCacheProviderOptions(policy)` MUST return `undefined` for `"off"`. For each other policy it MUST return one
directive for each vendor that takes an explicit breakpoint, each in the namespace of that vendor:
`anthropic.cacheControl` and `bedrock.cachePoint`. Both directives MUST carry the ttl of the policy.

A provider reads only its own namespace, thus the directive of one vendor is inert on another. As a result the placement
never learns which vendor serves the call. A vendor that caches without a marker gets none. The OpenAI family caches
prefixes server-side and exposes no breakpoint, and Gemini caches implicitly.

The two shapes differ in more than the name. Anthropic marks the last content block of the message. Bedrock appends a
`cachePoint` block after it. Both land at the same position of the prefix.

The module MUST hold the only two writers of a directive. Thus a request holds at most two breakpoints of the harness:

- `withSystemPromptBreakpoint(system, policy)` MUST mark the end of the system prompt. It MUST return a system message that carries the directive in its `providerOptions`.
- `withPromptCacheBreakpoint(messages, policy)` MUST put the directive on the LAST message that can carry it. It MUST remove the directive from each other message, thus the messages hold exactly one breakpoint. It MUST return a copy of the messages.

For `"off"`, `withSystemPromptBreakpoint` MUST return the system prompt as a plain string. It MUST also return an empty
system prompt as a plain string, thus no directive lands on an empty text block. The Anthropic package renders an empty
system prompt as an empty text block in both forms.

The system prompt of an agent depends only on its type. Thus the breakpoint at its end caches the tools and the system
prompt as one entry. Each call of that agent reads or writes the same entry. A new thread reads that entry back. The
first request after a shift of the message prefix also reads it back.

The harness MUST NOT attach a directive to the request itself, and `ChatRequest` carries no provider options. A
request-level directive reaches the wire as a top-level `cache_control` field. An intermediary counts blocks, thus it
cannot see that field.

CLIProxyAPI adds up to four block markers of its own, and it trims the total to the Anthropic limit of four by that
count. A marker on a block stays countable, thus the proxy trims the markers of the harness correctly. A top-level field
is a marker that the proxy does not count. The endpoint then answers HTTP 400, and the refusal is not retryable. The next
turn builds the same shape, thus the thread stops.

A copy is necessary because the caller keeps the transcript. A host writes that transcript to a thread store. A
directive in the store comes back on each later turn, and the count grows by one for each turn.

The removal is necessary because `memory/ai-sdk-message-storage.ts` reads `cache_control` off a stored block. Thus a row
from an older build can arrive with a directive on it. That directive spends a breakpoint that the harness did not
budget.

A message that ends with a thinking block cannot carry the directive. The provider drops it there and reports no error,
thus each later call misses the cache. `withPromptCacheBreakpoint` MUST move back to the last message that can carry the
directive. It MUST place none when no message can carry one.

The emitted options MUST be safe on every provider. AI SDK `providerOptions` is a namespaced bag, and each provider reads
only its own key from it. Thus a directive for one vendor is inert on another, and it is not an error. A vendor that
caches automatically needs no directive, thus the policy is a no-op for it. The OpenAI-compatible family does
server-side prefix caching without a directive.

#### Scenario: An off policy sends no directive

- **WHEN** `promptCacheProviderOptions("off")` is called
- **THEN** it MUST return `undefined`, and no message and no system prompt of the request MUST carry a directive

#### Scenario: A ttl policy emits one directive for each marker vendor

- **WHEN** `promptCacheProviderOptions({ ttl: "1h" })` is called
- **THEN** it MUST return `anthropic.cacheControl` and `bedrock.cachePoint`, and each one MUST carry that ttl

#### Scenario: The bedrock marker reaches the wire in the shape of that vendor

- **GIVEN** a transcript that `withPromptCacheBreakpoint` marked with a ttl policy
- **WHEN** the Bedrock provider renders the request
- **THEN** a `cachePoint` block MUST come after the content of the last message, and it MUST carry the ttl

#### Scenario: A marker of another vendor is removed from an earlier message

- **GIVEN** a transcript whose first message carries a `bedrock.cachePoint` directive
- **WHEN** `withPromptCacheBreakpoint` is called with a ttl policy
- **THEN** the first message MUST lose that directive, because the one-breakpoint invariant of the messages holds for each vendor

#### Scenario: The breakpoint goes on the last message

- **GIVEN** a transcript of three messages and a ttl policy
- **WHEN** `withPromptCacheBreakpoint` is called
- **THEN** only the third message MUST carry the directive

#### Scenario: A directive on an earlier message is removed

- **GIVEN** a transcript whose first message came from the store with a directive on it
- **WHEN** `withPromptCacheBreakpoint` is called with a ttl policy
- **THEN** the result MUST hold one directive, on the last message, and the first message MUST keep its other provider keys

#### Scenario: The placement moves back past a thinking block

- **GIVEN** a transcript whose last message is an assistant turn that ends with a thinking block
- **WHEN** `withPromptCacheBreakpoint` is called with a ttl policy
- **THEN** the directive MUST go on the message before it

#### Scenario: The transcript of the caller stays unmarked

- **GIVEN** a transcript that a host later writes to a thread store
- **WHEN** `withPromptCacheBreakpoint` is called
- **THEN** it MUST return a copy, and no message of the input MUST carry a directive

#### Scenario: An off policy strips a stored directive

- **GIVEN** a transcript whose first message came from the store with a directive on it
- **WHEN** `withPromptCacheBreakpoint` is called with `"off"`
- **THEN** the result MUST hold no directive at all

#### Scenario: The system prompt carries its own breakpoint

- **GIVEN** a ttl policy and a system prompt that is not empty
- **WHEN** `withSystemPromptBreakpoint` is called
- **THEN** it MUST return a system message whose `providerOptions` carry `anthropic.cacheControl` and `bedrock.cachePoint` with that ttl
- **AND** the Anthropic provider MUST render `cache_control` on the text block of the system prompt

#### Scenario: A request holds two breakpoints of the harness

- **GIVEN** a ttl policy and a transcript of three messages
- **WHEN** the loop builds a request with `withSystemPromptBreakpoint` and `withPromptCacheBreakpoint`
- **THEN** the system prompt and the third message MUST carry a directive, and no other message MUST carry one

#### Scenario: An off policy or an empty prompt leaves the system prompt plain

- **WHEN** `withSystemPromptBreakpoint` is called with `"off"`, or with an empty system prompt
- **THEN** it MUST return the system prompt as a plain string with no directive

#### Scenario: The directive is inert on a provider that did not ask for it

- **GIVEN** a request that carries a cache directive in the namespace of one provider
- **WHEN** it is sent to an OpenAI-compatible model
- **THEN** the model MUST ignore the foreign namespace and the call MUST succeed

### Requirement: Chat responses carry requested and served model identity

`ChatResponse` MUST carry three optional identity fields:

- `requestedModelId`: the id of the model that the provider instance is bound to.
- `servedModelId`: the model id that the provider response reported as the model that answered.
- `provider`: the provider id of the bound model, as the AI SDK names it in `LanguageModel.provider`, for example `anthropic.messages`.

Each field MUST be absent when it is not available. The harness MUST NOT guess a value. The harness MUST NOT treat a
mismatch of the two model ids as an error. The pair lets a consumer see when an endpoint or a proxy serves a different
model version than the configured one.

The loop labels its token counters with `servedModelId` and `provider`, as the harness-agent-loop capability describes.

#### Scenario: The served model is observable beside the requested one

- **GIVEN** a provider response that reports the id of the model that answered
- **WHEN** the `ChatResponse` is consumed
- **THEN** `servedModelId` MUST carry the reported id and `requestedModelId` MUST carry the id of the bound model, independently

#### Scenario: An endpoint that reports no model id yields no claim

- **GIVEN** a provider response without a model id
- **WHEN** the `ChatResponse` is consumed
- **THEN** `servedModelId` MUST be absent, and the harness MUST NOT fill it from the requested id

#### Scenario: The response names its provider

- **GIVEN** a provider made from an `anthropic` configuration
- **WHEN** `chat` returns
- **THEN** `ChatResponse.provider` MUST be `anthropic.messages`

#### Scenario: A bare model id names no provider

- **GIVEN** a provider made over a bare model-id string
- **WHEN** `chat` returns
- **THEN** `ChatResponse.provider` MUST be absent

## ADDED Requirements

### Requirement: The provider selects the effort in a fixed order

The provider MUST select the reasoning effort of each call from the first source that gives a value:

1. `ChatRequest.reasoning`, if the request sets it.
2. The `reasoning` of the provider configuration.
3. `DEFAULT_REASONING`, which is `xhigh`.

The provider MUST give the selected value to the AI SDK as the neutral `reasoning` call setting. Each provider package
then maps the name to its own wire shape for the bound model. The harness MUST NOT write a vendor key for the effort,
for example `providerOptions.anthropic.effort`. A value on such a key turns the table of the package off, and a model
that does not accept the raw name answers 400.

A direct `provider.chat` call without a value runs at the configured effort, not at the default of the model. The value
`"provider-default"` sends no directive, thus the model applies its own default.

#### Scenario: A request value wins

- **GIVEN** a provider configured with `reasoning: "high"`
- **WHEN** a request sets `reasoning: "low"`
- **THEN** the model call carries the reasoning `low`

#### Scenario: The configured value applies to a request without a value

- **GIVEN** a provider configured with `reasoning: "high"`
- **WHEN** a request sets no `reasoning`
- **THEN** the model call carries the reasoning `high`

#### Scenario: The default applies last

- **GIVEN** a provider configured without `reasoning`
- **WHEN** a request sets no `reasoning`
- **THEN** the model call carries the reasoning `xhigh`

#### Scenario: No vendor key carries the effort

- **WHEN** a provider runs any call
- **THEN** the call options from the harness carry no `providerOptions.anthropic.effort` and no `providerOptions.openai.reasoningEffort`

### Requirement: The provider reports each dropped thinking block

The provider MUST log one warning for each thinking block that the response reports as dropped. The Anthropic package
gives the drops in `providerMetadata.anthropic.inputTransformations`. Each record MUST carry the `type`, the `path`, and
the `reason` of the drop as structured fields, with the workload of the call. The drop MUST NOT fail the call, and the
provider MUST NOT retry the call because of it. The `chat` path and the `chatStream` path MUST log the same records.

The reason shows the cause. `prefix_binding_mismatch` shows a change of the prefix in the harness.
`model_binding_mismatch` shows a change of the model, for example a model switch of the CLI.

#### Scenario: A drop is logged

- **GIVEN** a response whose `inputTransformations` holds one entry with the path `messages.3.content.0` and the reason `prefix_binding_mismatch`
- **WHEN** `chat` returns
- **THEN** the provider writes one warn record with that path and that reason
- **AND** `chat` returns an `ok` value

#### Scenario: A response without drops logs nothing

- **GIVEN** a response with no `inputTransformations`
- **WHEN** `chat` returns
- **THEN** the provider writes no drop record

#### Scenario: The stream path logs the same drops

- **GIVEN** a streamed response whose metadata reports one drop
- **WHEN** `chatStream` yields its `done` event
- **THEN** the provider writes one warn record for that drop before the event

### Requirement: ChatRequest carries no provider options

`ChatRequest` MUST NOT carry a `providerOptions` field. The provider MUST make the provider options of each call itself.
These options are the session key, the thinking binding, and the `store` value of the `openai` arm. No production caller
sets a request-level bag. A free bag lets a caller write a vendor key that turns a table of the package off.

A cache marker rides a message or the system prompt, never the request. `ChatRequest.system` MUST accept a string or an
AI SDK `SystemModelMessage`, thus the system prompt can carry its own marker. The effort rides `ChatRequest.reasoning`.

#### Scenario: A request with provider options does not compile

- **GIVEN** the `ChatRequest` type
- **WHEN** a caller sets `providerOptions` on a request
- **THEN** the code fails to compile

#### Scenario: A marked system prompt reaches the model

- **GIVEN** a request whose `system` is the system message that `withSystemPromptBreakpoint` returns
- **WHEN** a provider runs the call
- **THEN** the model receives the system prompt with its cache directive
