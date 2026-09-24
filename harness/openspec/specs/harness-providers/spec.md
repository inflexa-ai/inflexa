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

**The provider owns the output-token cap.** `ChatRequest` does not expose
`max_tokens` — the provider sets the upstream cap from the model's true ceiling
(`maxOutputTokens(model)`). The loop never picks a cap; it recovers from any
residual truncation (see the harness-agent-loop spec).

**Prompt caching is a harness concept the seam translates.** `PromptCachePolicy` is
vendor-neutral; `providers/prompt-cache.ts` is the single site that turns it into
vendor wire options, so nothing upstream of the seam learns which vendor it is
talking to. What a call cost — cache reads and cache writes included — comes back
on `ChatResponse.usage`.

Both `chat` and `embed` return a `ResultAsync` over the `ProviderError` union —
a provider failure is a value in the error channel, never a thrown exception.
The sole thrown control-flow exception is a client abort, re-raised verbatim
outside the Result channel.
## Requirements
### Requirement: Prompt caching is a vendor-neutral policy translated at one site

The harness MUST express prompt caching as `PromptCachePolicy`. A value of
`{ ttl: "5m" | "1h" }` caches the request prefix for that lifetime. The prefix is
the tools, the system prompt, and the message history. A value of `"off"` sends no
cache directive at all.

`providers/prompt-cache.ts` MUST be the ONLY place in the harness that names a
vendor for caching. `promptCacheProviderOptions(policy)` MUST return `undefined`
for `"off"`. For each other policy it MUST return one directive for each vendor
that takes an explicit breakpoint, each in the namespace of that vendor:
`anthropic.cacheControl` and `bedrock.cachePoint`. Both directives MUST carry the
ttl of the policy.

A provider reads only its own namespace, thus the directive of one vendor is
inert on another. As a result the placement never learns which vendor serves the
call. A vendor that caches without a marker gets none: the OpenAI family caches
prefixes server-side and exposes no breakpoint, and Gemini caches implicitly.

The two shapes differ in more than the name. Anthropic marks the last content
block of the message. Bedrock appends a `cachePoint` block after it. Both land at
the same position of the prefix.

`withPromptCacheBreakpoint(messages, policy)` MUST place that directive, and it
MUST be the only writer of one. It MUST put the directive on the LAST message that
can carry it. It MUST remove the directive from each other message, thus a request
holds exactly one breakpoint. It MUST return a copy of the messages.

The harness MUST NOT attach the directive to a `ChatRequest`. A request-level
directive reaches the wire as a top-level `cache_control` field. An intermediary
counts blocks, thus it cannot see that field.

CLIProxyAPI adds its own block markers, and it trims them to the Anthropic limit
of four by that count. A top-level field then makes the total five, and the
endpoint answers HTTP 400. The refusal is not retryable, and the next turn builds
the same shape. Thus the thread stops.

A copy is necessary because the caller keeps the transcript. A host writes that
transcript to a thread store. A directive in the store comes back on each later
turn, and the count grows by one per turn.

The removal is necessary because `memory/ai-sdk-message-storage.ts` reads
`cache_control` off a stored block. Thus a row from an older build can arrive with
a directive on it. That directive spends a breakpoint that the harness did not
budget.

A message that ends with a thinking block cannot carry the directive. The provider
drops it there and reports no error, thus each later call misses the cache.
`withPromptCacheBreakpoint` MUST move back to the last message that can carry the
directive. It MUST place none when no message can carry one.

The emitted options MUST be safe on every provider. AI SDK `providerOptions` is a
namespaced bag, and each provider reads only its own key from it. Thus a directive
for one vendor is inert on another, and it is not an error. A vendor that caches
automatically needs no directive, thus the policy is a no-op for it. The
OpenAI-compatible family does server-side prefix caching, unprompted.

#### Scenario: An off policy sends no directive

- **WHEN** `promptCacheProviderOptions("off")` is called
- **THEN** it MUST return `undefined`, and the request MUST carry no `providerOptions`

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
- **THEN** the first message MUST lose that directive, because the one-breakpoint invariant holds per vendor

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

#### Scenario: The directive is inert on a provider that did not ask for it

- **GIVEN** a request that carries a cache directive in the namespace of one provider
- **WHEN** it is sent to an OpenAI-compatible model
- **THEN** the model MUST ignore the foreign namespace and the call MUST succeed

### Requirement: Chat usage reports the cache breakdown

`ChatResponse` SHALL carry an optional `usage: ChatUsage` with `inputTokens`,
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

### Requirement: A client abort resolves the streaming chat with the accumulated partial

The streaming `AgentChat` wrapper SHALL, when the client abort signal ends the underlying stream, resolve successfully with a `ChatResponse` whose finish reason is `"aborted"` and whose assistant message carries exactly the text deltas already forwarded — it SHALL NOT re-throw the abort and SHALL NOT route it through the provider-error channel. An abort that fires before any delta arrived SHALL resolve the same way with an empty assistant message. The wrapper's abort recognition SHALL be at least as wide as the underlying provider's abort re-throw gate (an abort-named error OR an already-aborted client signal): a transport failure that lands while the client signal is aborted SHALL resolve as the abort — the user's interrupt outranks a raced failure, and surfacing it as an error would drop the partial and blame the user's own action. `ChatResponse.finishReason` SHALL admit `"aborted"` alongside the AI SDK finish reasons, and the non-streaming `ChatProvider.chat` SHALL continue to propagate a client abort as a throw — `"aborted"` is producible only by the streaming wrapper, so durable workflow loops (which run on the non-streaming provider) keep their cancellation-by-throw semantics.

#### Scenario: An abort mid-stream yields the partial text

- **GIVEN** a streaming chat whose model has emitted several text deltas
- **WHEN** the client abort signal fires and the stream throws its abort
- **THEN** `chat` resolves with finish reason `"aborted"` and an assistant message containing exactly the concatenated deltas already forwarded

#### Scenario: An abort before the first delta yields an empty partial

- **GIVEN** a streaming chat call whose abort signal is already aborted (or fires before any delta)
- **WHEN** the stream throws its abort
- **THEN** `chat` resolves with finish reason `"aborted"` and an assistant message with no content

#### Scenario: A transport failure racing the abort resolves as the abort

- **GIVEN** a streaming chat whose underlying stream throws a non-abort failure while the client signal is already aborted
- **WHEN** `chat` consumes the throw
- **THEN** it resolves with finish reason `"aborted"` and the deltas already forwarded — no `ProviderError` for the user's own interrupt

#### Scenario: A non-abort stream failure still reaches the error channel

- **GIVEN** a streaming chat whose underlying stream throws a non-abort SDK failure with the client signal not aborted
- **WHEN** `chat` consumes the throw
- **THEN** it returns `err(ProviderError)` exactly as before — the abort resolution narrows only the abort case

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

The provider MUST return a failure of the AI SDK runtime as a `ProviderError` value in the harness error channel. It
MUST NOT give an unclassified SDK exception. `ProviderError` MUST be the discriminated union
`{ type: "auth" } | { type: "suspend"; reason: string; status?: number } | { type: "provider" }`. The `auth` and
`suspend` kinds MUST NOT be retryable. A rate limit, a 5xx, and a connection failure MUST be retryable `provider`
failures. Another concrete 4xx failure MUST be a non-retryable `provider` failure.

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
- **THEN** it resolves to an `err` whose `ProviderError` has `type: "suspend"`, `status: 402`, `reason: "payment_required"`, and `retryable: false`

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

### Requirement: Transient provider failures are retried under a bounded backoff policy

The AI SDK chat provider SHALL retry a failed model call before surfacing a `ProviderError`, under a harness-owned policy: up to 10 retries with exponential backoff (2s initial delay, ×2 factor) where every individual delay is capped at 30 seconds, jittered, and a `Retry-After`/`retry-after-ms` response header SHALL be honored when it parses to a value between zero and the cap. The retry predicate MUST be the retryability that `classifyProviderError` gives with the `suspendOn` map of the provider. The provider MUST retry a transient failure (429, 5xx, or connection-level). The provider MUST NOT retry an `auth` failure, a `suspend` failure, or another concrete 4xx failure. A status in the `suspendOn` map gives a `suspend` failure, also when the status is a `429` or a 5xx.

The AI SDK's internal retry SHALL be disabled (`maxRetries: 0`) so attempts do not multiply. A client abort SHALL propagate immediately, including when it fires during a backoff sleep. When retries are exhausted, the error surfaced to classification SHALL carry the last underlying provider failure on its `cause` chain so the resulting `ProviderError` keys on the real HTTP status.

The provider MUST call the `resolveRequestHeaders` hook before each attempt, not one time for each call. An `err` from
the hook MUST stop the call at once, with no retry.

#### Scenario: A provider that fails to respond is retried until it recovers

- **WHEN** the wire call fails with a connection-level error (e.g. `ECONNREFUSED`) on the first attempts and then succeeds
- **THEN** `chat` resolves `ok` with the successful response, and the number of wire calls equals the failed attempts plus one

#### Scenario: A non-retryable failure short-circuits

- **WHEN** the wire call fails with a `401`, `402`, `403`, or another concrete non-transient `4xx`
- **THEN** `chat` returns the classified `err(ProviderError)` after exactly one wire call

#### Scenario: A mapped status is not retried

- **GIVEN** a provider whose `suspendOn` map holds `429`
- **WHEN** the wire call fails with a `429`
- **THEN** `chat` returns an `err` of the kind `suspend` after exactly one wire call

#### Scenario: A hook err stops the retries

- **GIVEN** a wire call that fails with a `503`, and a `resolveRequestHeaders` hook that gives `ok` first and `err` second
- **WHEN** `chat` runs
- **THEN** `chat` returns the `err` of the hook after exactly one wire call, with no further retry

#### Scenario: Exhausted retries classify by the last real failure

- **WHEN** every attempt fails with a `503`
- **THEN** after 11 wire calls (1 initial + 10 retries) `chat` returns `err` with `type: "provider"` and `retryable: true`, classified from the `503` on the cause chain

#### Scenario: An abort during backoff propagates immediately

- **WHEN** the caller's `AbortSignal` fires while the provider is sleeping between attempts
- **THEN** the abort error is re-thrown without further attempts and without waiting out the backoff delay

#### Scenario: A streaming call retries only until the first delta

- **WHEN** `chatStream` fails before any text delta has been yielded to the consumer
- **THEN** the stream establishment is retried under the same policy
- **WHEN** a failure occurs after at least one text delta has been yielded
- **THEN** the error propagates without retry and no text is ever yielded twice

### Requirement: Chat responses carry requested and served model identity

`ChatResponse` SHALL carry an optional `requestedModelId` — the id of the model the provider instance is bound to — and an optional `servedModelId` — the model id the provider response reported as having answered. Both SHALL be absent when unavailable rather than guessed, and the harness SHALL NOT treat a mismatch as an error: the pair exists so consumers can observe when an endpoint or proxy serves a different model version than the one configured.

#### Scenario: The served model is observable beside the requested one

- **GIVEN** a provider response that reports the answering model's id
- **WHEN** the `ChatResponse` is consumed
- **THEN** `servedModelId` SHALL carry the reported id and `requestedModelId` the bound model's id, independently

#### Scenario: An endpoint that reports no model id yields no claim

- **GIVEN** a provider response without a model id
- **WHEN** the `ChatResponse` is consumed
- **THEN** `servedModelId` SHALL be absent — never populated from the requested id

### Requirement: ChatProvider advertises an optional request-timeout limit

The `ChatProvider` interface MUST carry an optional readonly `requestTimeoutMs` field. A provider that enforces a request timeout MUST advertise the enforced value there. A consumer that scales a deadline from the provider MUST read this field from the provider instance in its deps, not from a harness constant. An absent field means that the provider enforces no request timeout of its own.

#### Scenario: A configured provider advertises its limit

- **WHEN** a provider is constructed from a configuration that sets `requestTimeoutMs`
- **THEN** the provider instance exposes the same value on its `requestTimeoutMs` field

#### Scenario: A provider without a limit stays unchanged

- **WHEN** a provider is constructed from a configuration without `requestTimeoutMs`
- **THEN** the `requestTimeoutMs` field of the instance is absent
- **AND** each consumer applies its own default deadline

### Requirement: chatStream surfaces a mid-stream timeout as an error event

`chatStream` MUST map the SDK `abort` stream part to a terminal provider error that names the timeout. A quiet stream end with partial text after a timeout MUST be unrepresentable on the harness surface. When the abort signal of the caller is aborted, the cancellation path MUST apply unchanged.

#### Scenario: A mid-stream timeout becomes an error event

- **GIVEN** a stream whose content stalls past the configured window
- **WHEN** the SDK aborts the stream and emits its `abort` part
- **THEN** `chatStream` terminates with a provider error that names the timeout
- **AND** the partial text does not end the stream quietly

#### Scenario: A caller abort stays a cancellation

- **GIVEN** a caller that aborts its signal mid-stream
- **WHEN** the stream ends with the SDK `abort` part
- **THEN** the cancellation path applies, not the timeout error

### Requirement: The provider capability set names the picture placement

The `ProviderCapabilities` set MUST carry two optional picture flags: `imageToolResults` and `imageUserMessages`. `imageToolResults` says that the wire renders an image block inside a tool result. `imageUserMessages` says that the wire renders an image inside a user message. An absent flag means "cannot carry", never "unknown". The provider factory MUST copy a stated flag onto the built provider, and it MUST NOT invent a value for an absent one.

#### Scenario: The embedder states the fallback flag

- **WHEN** a provider is constructed with `capabilities: { imageUserMessages: true }`
- **THEN** the built provider advertises `imageUserMessages: true`

#### Scenario: An absent flag stays absent

- **WHEN** a provider is constructed with no picture flag in its capability config
- **THEN** the built provider advertises neither picture flag

