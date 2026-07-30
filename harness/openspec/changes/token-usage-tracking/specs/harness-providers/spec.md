# harness-providers Specification (delta)

## MODIFIED Requirements

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

## ADDED Requirements

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
