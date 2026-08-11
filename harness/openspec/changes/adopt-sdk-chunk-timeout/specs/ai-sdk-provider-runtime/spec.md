# ai-sdk-provider-runtime Delta

## MODIFIED Requirements

### Requirement: The provider bounds each silent interval of an attempt

When `requestTimeoutMs` is set, the provider MUST bound each silent interval of a request attempt. A silent interval is the wait until the response starts, or a gap between two content chunks. The response-start wait MUST be bounded by the provider's own guard timer, and the timer MUST clear when the headers arrive. Each content gap of a streamed body MUST be bounded through the SDK `timeout` setting with `chunkMs`. A chunk that carries no content, for example a keep-alive comment, MUST NOT reset the gap bound. The guard MUST compose with the abort signal of the caller, and the caller signal MUST keep its normal effect. The guard MUST apply per attempt, so each retry of the envelope receives a full window. The total length of a stream with steady content MUST NOT trip any bound.

#### Scenario: A slow response start trips the guard

- **GIVEN** a provider with `requestTimeoutMs` set
- **WHEN** the endpoint does not start its response within the window
- **THEN** the attempt is aborted with a typed request-timeout reason

#### Scenario: A steady stream does not trip the guard

- **GIVEN** a streamed response whose headers arrived within the window
- **WHEN** the stream runs longer than `requestTimeoutMs` with each content gap under the window
- **THEN** no bound aborts the stream

#### Scenario: A stalled stream trips the SDK bound

- **GIVEN** a streamed response whose headers arrived within the window
- **WHEN** no content chunk arrives for `requestTimeoutMs`
- **THEN** the attempt is aborted through the SDK chunk bound

#### Scenario: A keep-alive does not feed the stream

- **GIVEN** a streamed response that emits keep-alive comments without content
- **WHEN** no content chunk arrives for `requestTimeoutMs`
- **THEN** the attempt is aborted, because a keep-alive does not reset the gap bound

#### Scenario: The caller abort still cancels

- **GIVEN** a provider with `requestTimeoutMs` set
- **WHEN** the abort signal of the caller fires before any window closes
- **THEN** the request is canceled as a caller abort, not as a timeout

### Requirement: A guard expiry classifies as a retryable provider timeout

A guard abort MUST surface as a provider error with `retryable: true`, and its message MUST name the configured value. An error named `TimeoutError`, the DOMException that the SDK `timeout` setting raises, MUST classify the same way. The classification MUST NOT treat either as a caller cancellation. The envelope MUST retry them under the same policy as a connection error. When the abort signal of the caller is aborted, the envelope MUST rethrow without a retry. Thus a wall-clock expiry that rides the caller signal never loops.

#### Scenario: The envelope retries a guard expiry

- **WHEN** the guard aborts an attempt and the retry limit is not reached
- **THEN** the envelope makes another attempt with a fresh window

#### Scenario: The envelope retries an SDK chunk timeout

- **WHEN** the SDK chunk bound aborts an attempt and the retry limit is not reached
- **THEN** the envelope makes another attempt with a fresh window

#### Scenario: A caller-signal expiry does not loop

- **GIVEN** a caller signal that a wall-clock guard aborted with a `TimeoutError` reason
- **WHEN** the provider call fails
- **THEN** the envelope rethrows without a retry

## REMOVED Requirements

### Requirement: The embedder fetch owns the transport floor

**Reason**: The transport lift moves into the harness, so each Bun embedder gets a working timeout with no composition work.
**Migration**: The provider guard adds `timeout: false` to the fetch init. A Node embedder above 300 seconds still supplies a dispatcher-raised fetch.

## ADDED Requirements

### Requirement: The harness supplies the Bun transport lift

When `requestTimeoutMs` is set, the fetch wrapper MUST add `timeout: false` to the fetch init. The key is a Bun extension: it lifts the 300-second idle cut under Bun, and it is inert under Node. The documentation of `requestTimeoutMs` MUST state the Node caveat: the undici floor stays, and a Node embedder above 300 seconds supplies a dispatcher-raised fetch. When the field is absent, the wrapper MUST NOT be installed, and the init MUST stay untouched.

#### Scenario: A Bun embedder needs no composition work

- **GIVEN** a Bun host with `requestTimeoutMs` above 300 seconds and no custom fetch
- **WHEN** the endpoint starts its response after 300 seconds but within the window
- **THEN** the request completes, because the guard lifted the idle cut

#### Scenario: An absent field touches nothing

- **WHEN** a provider is constructed without `requestTimeoutMs`
- **THEN** no wrapper is installed and no `timeout` key is added to any fetch init
