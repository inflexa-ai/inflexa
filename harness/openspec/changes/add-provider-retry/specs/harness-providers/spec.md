# harness-providers — Delta

## ADDED Requirements

### Requirement: Transient provider failures are retried under a bounded backoff policy

The AI SDK chat provider SHALL retry a failed model call before surfacing a `ProviderError`, under a harness-owned policy: up to 10 retries with exponential backoff (2s initial delay, ×2 factor) where every individual delay is capped at 30 seconds, jittered, and a `Retry-After`/`retry-after-ms` response header SHALL be honored when it parses to a value between zero and the cap. The retry predicate SHALL be the harness's own `classifyProviderError` retryability — transient failures (429, 5xx, connection-level) retry; `auth`, `budget`, `tenant-blocked`, and other concrete 4xx failures SHALL NOT be retried. The AI SDK's internal retry SHALL be disabled (`maxRetries: 0`) so attempts do not multiply. A client abort SHALL propagate immediately, including when it fires during a backoff sleep. When retries are exhausted, the error surfaced to classification SHALL carry the last underlying provider failure on its `cause` chain so the resulting `ProviderError` keys on the real HTTP status. Attribution headers SHALL be resolved via the `ResolveBilling` seam per attempt, not once per call.

#### Scenario: A provider that fails to respond is retried until it recovers

- **WHEN** the wire call fails with a connection-level error (e.g. `ECONNREFUSED`) on the first attempts and then succeeds
- **THEN** `chat` resolves `ok` with the successful response, and the number of wire calls equals the failed attempts plus one

#### Scenario: A non-retryable failure short-circuits

- **WHEN** the wire call fails with a `401`, `402`, `403`, or another concrete non-transient `4xx`
- **THEN** `chat` returns the classified `err(ProviderError)` after exactly one wire call

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
