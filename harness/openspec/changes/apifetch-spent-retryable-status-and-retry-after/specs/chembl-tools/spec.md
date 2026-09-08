## MODIFIED Requirements

### Requirement: Error handling, retry, and timeout

ChEMBL tools MUST treat a `404` as an expected "not found" and return an empty result array, not an error. The shared `apiFetch` boundary MUST retry `429`, `502`, `503`, and `504` with exponential backoff up to `maxRetries` (3, thus up to 4 attempts). It MUST apply a default request timeout of 90 seconds. When the response carries `Retry-After`, in seconds or as an HTTP date, the wait MUST be that value. Each wait, the server value included, MUST stay at or below `maxRetryDelayMs`, whose default is 30 seconds. A retryable status on the last attempt MUST resolve to the `exhausted` error, not to `http_status`, thus `isUnexpectedApiError` reads it as unexpected. Any unexpected failure — 5xx, timeout, or retry exhaustion — MUST be thrown out of `execute` so the agent loop wraps it as `tool_result { is_error: true }`. The tools do not return a self-authored error envelope.

#### Scenario: Target not found returns empty

- **WHEN** `search_targets` is called with a query that resolves to no target (404)
- **THEN** it returns an empty `targets` array, not an error

#### Scenario: Rate limit triggers backoff retry

- **WHEN** the ChEMBL API returns 429 or 503
- **THEN** `apiFetch` retries after exponential backoff up to 3 retries

#### Scenario: Retry-After sets the wait, under the cap

- **WHEN** the ChEMBL API returns 429 with `Retry-After: 2`, and `maxRetryDelayMs` is 50
- **THEN** `apiFetch` waits 50 milliseconds, then it retries

#### Scenario: A throttle that outlives the retries surfaces as an error tool result

- **WHEN** the ChEMBL API returns 429 on every attempt
- **THEN** `apiFetch` resolves to the `exhausted` error, `isUnexpectedApiError` gives true, and `execute` throws

#### Scenario: Server error surfaces as an error tool result

- **WHEN** the ChEMBL API returns a 5xx after retries are exhausted
- **THEN** `execute` throws and the agent loop records the call as `tool_result { is_error: true }`
