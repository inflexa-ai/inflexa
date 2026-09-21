## MODIFIED Requirements

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

## REMOVED Requirements

### Requirement: Attribution headers are resolved from the Session

**Reason**: The `ResolveBilling` seam goes (design D2). The optional gate `resolveRequestHeaders` replaces it, and the
harness names no billing seam. `createNoopBillingResolver`, `BillingResolutionError`, and the wrapper
`BillingSeamFailure` also go.

**Migration**: The requirement "The model request headers hook" of the host-hooks capability gives the new rule. An
embedder that used `createNoopBillingResolver` gives no hook. An embedder that attributes a model call gives
`resolveRequestHeaders` to each provider. A hook failure is an `err` that carries a `GateFailure`, not a thrown
`BillingResolutionError`.
