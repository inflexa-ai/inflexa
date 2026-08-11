# ai-sdk-provider-runtime Delta

## ADDED Requirements

### Requirement: Provider configuration accepts a request timeout

Both arms of `AiSdkProviderConfig` MUST accept an optional `requestTimeoutMs` field. When the field is absent, the provider behavior MUST stay identical to the behavior before this change.

#### Scenario: The field is absent

- **WHEN** a provider is constructed without `requestTimeoutMs`
- **THEN** no guard timer is armed and no fetch wrapper for the guard is installed

### Requirement: The provider bounds each silent interval of an attempt

When `requestTimeoutMs` is set, the provider MUST bound each silent interval of a request attempt. A silent interval is the wait until the response starts, or a gap between two body chunks. If a silent interval exceeds `requestTimeoutMs`, the provider MUST abort that attempt. The guard MUST compose with the abort signal of the caller, and the caller signal MUST keep its normal effect. The guard MUST apply per attempt, so each retry of the envelope receives a full window. The total length of a stream with steady chunks MUST NOT trip the guard.

#### Scenario: A slow response start trips the guard

- **GIVEN** a provider with `requestTimeoutMs` set
- **WHEN** the endpoint does not start its response within the window
- **THEN** the attempt is aborted with a typed request-timeout reason

#### Scenario: A steady stream does not trip the guard

- **GIVEN** a streamed response whose headers arrived within the window
- **WHEN** the stream runs longer than `requestTimeoutMs` with each chunk gap under the window
- **THEN** the guard does not abort the stream

#### Scenario: A stalled stream trips the guard

- **GIVEN** a streamed response whose headers arrived within the window
- **WHEN** no body chunk arrives for `requestTimeoutMs`
- **THEN** the attempt is aborted with the typed request-timeout reason

#### Scenario: The caller abort still cancels

- **GIVEN** a provider with `requestTimeoutMs` set
- **WHEN** the abort signal of the caller fires before the window closes
- **THEN** the request is canceled as a caller abort, not as a timeout

### Requirement: A guard expiry classifies as a retryable provider timeout

A guard abort MUST surface as a provider error with `retryable: true`, and its message MUST name the configured value. The classification MUST NOT treat a guard abort as a caller cancellation. The envelope MUST retry it under the same policy as a connection error.

#### Scenario: The envelope retries a guard expiry

- **WHEN** the guard aborts an attempt and the retry limit is not reached
- **THEN** the envelope makes another attempt with a fresh window

#### Scenario: The retry limit ends the call

- **WHEN** the guard aborts an attempt and the retry limit is reached
- **THEN** the provider call fails with the timeout error

### Requirement: The retry count of the envelope is configurable

Both arms of `AiSdkProviderConfig` MUST accept an optional `maxRetries` field. The retry envelope MUST use the value as its retry limit. An absent field MUST keep the current limit of 10.

#### Scenario: A configured count bounds the retries

- **WHEN** a provider with `maxRetries: 2` meets three retryable failures in a row
- **THEN** the envelope stops after 2 retries and surfaces the failure

#### Scenario: An absent count keeps the default

- **WHEN** a provider is constructed without `maxRetries`
- **THEN** the envelope retries up to 10 times, as before

### Requirement: The embedder fetch owns the transport floor

The harness MUST NOT configure the transport of the host runtime. The documentation of `requestTimeoutMs` MUST state the contract: the supplied `fetch` realization must permit a silent wait of at least `requestTimeoutMs`. When the transport of the embedder cuts a request before the guard window closes, the existing connection-error classification MUST apply unchanged.

#### Scenario: A transport cut below the guard window

- **GIVEN** an embedder fetch whose own limit is shorter than `requestTimeoutMs`
- **WHEN** the transport cuts the request first
- **THEN** the failure classifies through the existing connection-error path
