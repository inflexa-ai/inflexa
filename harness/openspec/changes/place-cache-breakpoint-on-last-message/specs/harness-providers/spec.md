## MODIFIED Requirements

### Requirement: Prompt caching is a vendor-neutral policy translated at one site

The harness MUST express prompt caching as `PromptCachePolicy`. A value of
`{ ttl: "5m" | "1h" }` caches the request prefix for that lifetime. The prefix is
the tools, the system prompt, and the message history. A value of `"off"` sends no
cache directive at all.

`providers/prompt-cache.ts` MUST be the ONLY place in the harness that names a
vendor for caching. `promptCacheProviderOptions(policy)` MUST return `undefined`
for `"off"`. For each other policy it MUST return one `cacheControl` directive in
the namespace of the provider.

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

#### Scenario: A ttl policy emits one namespaced cache directive

- **WHEN** `promptCacheProviderOptions({ ttl: "1h" })` is called
- **THEN** it MUST return a single provider-namespaced `cacheControl` directive that carries that ttl

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
