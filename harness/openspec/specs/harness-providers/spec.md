# harness-providers Specification

## Purpose

Define the harness's LLM and embedding provider seam — the narrow,
vendor-neutral interfaces (`ChatProvider`, `EmbeddingProvider`) through
which all model traffic flows. Each call carries an `AgentSession`, adds the
headers of the optional `resolveRequestHeaders` hook of the host (see the
host-hooks spec), runs over the AI SDK language-model provider runtime, and
classifies provider failures.

**AI SDK `ModelMessage` is the harness's lingua franca.** The provider seam is
backed by AI SDK-compatible language models supplied by the embedder (see the
ai-sdk-provider-runtime spec); thread history stores AI SDK model-message
envelopes (see the ai-sdk-message-storage spec). Signed provider metadata
required for continuation (e.g. Anthropic signed thinking/cache metadata) rides
provider-scoped in AI SDK provider metadata fields and is preserved through
storage and replay.

**The provider owns the output-token cap.** A run does not expose
`max_tokens` — the provider sets the upstream cap through the `maxOutputTokens`
setting of the model that it binds. The loop never picks a cap. A reply cut at
the output limit ends the run (see the harness-agent-loop spec).

**Prompt caching is a harness concept the seam translates.** `PromptCachePolicy` is
vendor-neutral; `providers/prompt-cache.ts` is the single site that turns it into
vendor wire options, so nothing upstream of the seam learns which vendor it is
talking to. What a call cost — cache reads and cache writes included — comes back
as the `ChatUsage` of the call.

`embed` returns a `ResultAsync` over the `ProviderError` union. The AI SDK drives
each model call, thus a model call that fails after its last attempt throws a
`ResultError` that carries the classified `ProviderError`. A client abort is
re-raised verbatim, outside the `ProviderError` channel.

## Requirements

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

The harness MUST NOT attach a cache directive to the request itself. A
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

### Requirement: Chat usage reports the cache breakdown

The usage of each model call SHALL map to a `ChatUsage` with `inputTokens`,
`outputTokens`, `cacheCreationInputTokens`, `cacheReadInputTokens`, and
`reasoningTokens`, in harness-neutral names. `inputTokens` SHALL be the *total*
billed prefix — cached and uncached alike — so a cache hit rate is
`cacheReadInputTokens / inputTokens`, not a ratio against a separate uncached
figure. `reasoningTokens` SHALL be exactly what the provider reported: the
harness SHALL NOT derive it from, or reconcile it against, `outputTokens`
(whether reasoning tokens are a subset of output tokens varies by provider).

Every field SHALL be optional, and absent SHALL mean "not reported", never "zero": a
provider that reports no usage at all, or reports totals without a cache breakdown,
is legitimate and SHALL NOT be normalized into zeros.

#### Scenario: A cache hit is reported against the total prefix

- **GIVEN** a provider reply whose prefix was served from the cache
- **WHEN** its usage is read
- **THEN** `cacheReadInputTokens` SHALL be a subset of `inputTokens`, not a figure beside it

#### Scenario: A provider reporting no usage contributes nothing

- **GIVEN** a provider that reports no token usage
- **WHEN** the response is consumed
- **THEN** `usage` (or its individual fields) SHALL be absent rather than zero

#### Scenario: Reasoning tokens pass through unreconciled

- **GIVEN** a provider reply reporting reasoning tokens
- **WHEN** its usage is mapped to `ChatUsage`
- **THEN** `reasoningTokens` SHALL carry the reported figure verbatim, and SHALL be absent when the provider reports none

### Requirement: The provider owns the per-model output-token cap

The provider SHALL set the upstream `max_tokens` through the `maxOutputTokens` setting of its bound model, not the caller. `LoopOptions` and `AgentDefinition` SHALL NOT expose `max_tokens`.

#### Scenario: max_tokens is not a caller-supplied field

- **GIVEN** the `LoopOptions` type
- **WHEN** a caller runs a loop
- **THEN** no field of the type sets `max_tokens`, and the bound model of the provider supplies `maxOutputTokens`

### Requirement: Every provider call requires a Session

AI SDK chat/model calls and `EmbeddingProvider.embed` SHALL each require an `AgentSession` parameter, so the same provider runtime serves a live request and a durable workflow run. No code path SHALL issue an LLM or embedding call without a session. The session MUST NOT carry request headers. The provider MUST get them at the call site from the optional `resolveRequestHeaders` hook, as the host-hooks capability describes.

#### Scenario: A provider call without a session does not type-check

- **GIVEN** the provider interface
- **WHEN** a caller invokes a model call without an `AgentSession` argument
- **THEN** the code fails to compile

#### Scenario: Either bundle satisfies the provider seam

- **GIVEN** the provider interface taking an `AgentSession`
- **WHEN** a `RequestSession` or a `RunSession` is passed
- **THEN** both type-check, and run/step attribution is available only when the session carries a `RunFrame`

#### Scenario: A provider is made with an optional headers hook

- **GIVEN** the provider factory
- **WHEN** a caller makes a provider without `resolveRequestHeaders`
- **THEN** the code type-checks, and the requests of the provider carry no header from a hook

#### Scenario: A test gives a fake headers hook

- **GIVEN** a provider with a fake `resolveRequestHeaders` that gives `okAsync` of a static map
- **WHEN** the provider sends a request
- **THEN** the request carries that static map

### Requirement: Provider failures are returned as a classified ProviderError value

The provider MUST give a failure of the AI SDK runtime as a classified `ProviderError` value. A model call that fails
after its last attempt MUST throw a `ResultError` that carries the value. It MUST NOT give an unclassified SDK exception. `ProviderError` MUST be the discriminated union
`{ type: "auth" } | { type: "suspend"; reason: string; status?: number } | { type: "provider" }`. The `auth` and
`suspend` kinds MUST NOT be retryable. A rate limit, a 5xx, and a connection failure MUST be retryable `provider`
failures. Another concrete 4xx failure MUST be a non-retryable `provider` failure. Only an error status, 400 or
higher, MUST classify. A failure that carries a status below 400 came after a response that started, for example a
stream that a reset connection broke. It MUST classify by the connection check, the same as a failure with no status.

A provider `401` — read from the failure itself or from anywhere on its `cause` chain — SHALL classify as `auth`, and the wrapped `auth` message SHALL name the credential as the broken thing (expired, revoked, or absent), never the request. Classification SHALL key on the HTTP status only, never on provider message text. A client abort SHALL be re-thrown verbatim rather than classified.

The configuration of each provider MUST accept an optional `suspendOn: Readonly<Record<number, string>>`. The map
gives a suspend reason for each HTTP status code in it. If the configuration gives no map, the provider MUST use the
default map `{ 402: "payment_required" }`. A map from the host MUST replace the default map. If the HTTP status of a
failure is in the map, the failure MUST classify as `suspend`, before each other status rule. The `suspend` error MUST
carry that status and the reason of the map.

The provider MUST NOT retry a `suspend` error. A `suspend` error from the request headers hook has no status, as the
host-hooks capability describes. A `403` that is not in the map MUST classify as a non-retryable `provider` error, the
same as another concrete 4xx. The message of a `suspend` error MUST have the same generic HTTP form as the message of
a `provider` error. A message MUST NOT name a budget, a tenant, or a billing gateway.

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

#### Scenario: A status in the default map is a suspend error

- **GIVEN** a provider with no `suspendOn` map
- **WHEN** the model call fails with a `402`
- **THEN** it throws a `ResultError` whose `ProviderError` has `type: "suspend"`, `status: 402`, `reason: "payment_required"`, and `retryable: false`

#### Scenario: A map from the host replaces the default map

- **GIVEN** a provider with `suspendOn: { 429: "quota" }`
- **WHEN** the model call fails with a `429`
- **THEN** the `ProviderError` has `type: "suspend"`, `status: 429`, and `reason: "quota"`
- **WHEN** the model call fails with a `402`
- **THEN** the `ProviderError` has `type: "provider"` and `retryable: false`

#### Scenario: A 403 outside the map is a provider error

- **GIVEN** a provider whose `suspendOn` map does not hold `403`
- **WHEN** the model call fails with a `403`
- **THEN** the `ProviderError` has `type: "provider"` and `retryable: false`

#### Scenario: A suspend message is a generic HTTP message

- **GIVEN** a model call that fails with a status in the `suspendOn` map
- **WHEN** the provider classifies the failure
- **THEN** the message names the workload and the HTTP status, and it names no budget, no tenant, and no gateway

#### Scenario: A transient upstream error is retryable

- **GIVEN** a provider 503 response
- **WHEN** the failure is classified
- **THEN** the `ProviderError` has `type: "provider"` with `retryable: true`

#### Scenario: A stream that broke after a 200 is retryable

- **GIVEN** a model call whose response started with the status `200`, and whose stream a reset connection broke
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
- **THEN** the call re-throws it verbatim rather than a `ResultError` that carries a `ProviderError`

### Requirement: Chat responses carry requested and served model identity

The accounting of each model call MUST read three optional identity fields:

- `requestedModelId`: the id of the model that the provider instance is bound to.
- `servedModelId`: the model id that the provider response reported as the model that answered.
- `provider`: the provider id of the bound model, as the AI SDK names it in `LanguageModel.provider`, for example `anthropic.messages`.

Each field MUST be absent when it is not available. The harness MUST NOT guess a value. The harness MUST NOT treat a
mismatch of the two model ids as an error. The pair lets a consumer see when an endpoint or a proxy serves a different
model version than the configured one.

The loop labels its token counters with `servedModelId` and `provider`, as the harness-agent-loop capability describes.

#### Scenario: The served model is observable beside the requested one

- **GIVEN** a provider response that reports the id of the model that answered
- **WHEN** the call is accounted
- **THEN** `servedModelId` MUST carry the reported id and `requestedModelId` MUST carry the id of the bound model, independently

#### Scenario: An endpoint that reports no model id yields no claim

- **GIVEN** a provider response without a model id
- **WHEN** the call is accounted
- **THEN** `servedModelId` MUST be absent, and the harness MUST NOT fill it from the requested id

#### Scenario: The response names its provider

- **GIVEN** a provider made from an `anthropic` configuration
- **WHEN** a model call completes
- **THEN** the token counters of the call MUST carry the provider `anthropic.messages`

### Requirement: The provider capability set names the picture placement

The `ProviderCapabilities` set MUST carry one optional picture flag: `imageToolResults`. It says that the wire renders an image block inside a tool result. An absent flag means "cannot carry", never "unknown". The provider factory MUST copy a stated flag onto the built provider, and it MUST NOT invent a value for an absent one.

#### Scenario: The embedder states the flag

- **WHEN** a provider is constructed with `capabilities: { imageToolResults: true }`
- **THEN** the built provider advertises `imageToolResults: true`

#### Scenario: An absent flag stays absent

- **WHEN** a provider is constructed with no picture flag in its capability config
- **THEN** the built provider advertises no picture flag

### Requirement: The provider selects the effort in a fixed order

The provider MUST select the reasoning effort of each call from the first source that gives a value:

1. The `reasoning` of the run (`LoopOptions.reasoning`), if the run sets it.
2. The `reasoning` of the provider configuration.
3. `DEFAULT_REASONING`, which is `xhigh`.

The provider MUST give the selected value to the AI SDK as the neutral `reasoning` call setting. Each provider package
then maps the name to its own wire shape for the bound model. The harness MUST NOT write a vendor key for the effort,
for example `providerOptions.anthropic.effort`. A value on such a key turns the table of the package off, and a model
that does not accept the raw name answers 400.

A run without a value runs at the configured effort, not at the default of the model. The value
`"provider-default"` sends no directive, thus the model applies its own default.

#### Scenario: A run value wins

- **GIVEN** a provider configured with `reasoning: "high"`
- **WHEN** a run sets `reasoning: "low"`
- **THEN** the model call carries the reasoning `low`

#### Scenario: The configured value applies to a run without a value

- **GIVEN** a provider configured with `reasoning: "high"`
- **WHEN** a run sets no `reasoning`
- **THEN** the model call carries the reasoning `high`

#### Scenario: The default applies last

- **GIVEN** a provider configured without `reasoning`
- **WHEN** a run sets no `reasoning`
- **THEN** the model call carries the reasoning `xhigh`

#### Scenario: No vendor key carries the effort

- **WHEN** a provider runs any call
- **THEN** the call options from the harness carry no `providerOptions.anthropic.effort` and no `providerOptions.openai.reasoningEffort`

### Requirement: The provider reports each dropped thinking block

The provider MUST log one warning for each thinking block that the response reports as dropped. The Anthropic package
gives the drops in `providerMetadata.anthropic.inputTransformations`. Each record MUST carry the `type`, the `path`, and
the `reason` of the drop as structured fields, with the workload of the call. The drop MUST NOT fail the call, and the
provider MUST NOT retry the call because of it. A call with a live reader and a call with no live reader MUST log the
same records.

The reason shows the cause. `prefix_binding_mismatch` shows a change of the prefix in the harness.
`model_binding_mismatch` shows a change of the model, for example a model switch of the CLI.

#### Scenario: A drop is logged

- **GIVEN** a response whose `inputTransformations` holds one entry with the path `messages.3.content.0` and the reason `prefix_binding_mismatch`
- **WHEN** the model call completes
- **THEN** the provider writes one warn record with that path and that reason
- **AND** the call completes with no error

#### Scenario: A response without drops logs nothing

- **GIVEN** a response with no `inputTransformations`
- **WHEN** the model call completes
- **THEN** the provider writes no drop record

#### Scenario: The live path logs the same drops

- **GIVEN** a call with a live reader whose finish metadata reports one drop
- **WHEN** the finish part reaches the reader
- **THEN** the provider writes one warn record for that drop before the part
