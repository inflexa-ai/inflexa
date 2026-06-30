## Purpose
Defines the sandbox-server (Go) HTTP API embedded in every sandbox container — entrypoint, command-execution protocol, callbacks, and the static-file preview endpoint.
## Requirements
### Requirement: sandbox-server binary and container entrypoint

The sandbox-server binary SHALL be a statically-linked Go binary located at `/usr/local/bin/sandbox-server`. It SHALL start as the container's entrypoint and listen on port 8765 (or the port specified by `SANDBOX_SERVER_PORT`). It SHALL serve the health, exec, kill, and preview endpoints.

#### Scenario: Server starts as container entrypoint
- **WHEN** the sandbox container starts
- **THEN** the server SHALL listen on `0.0.0.0:8765` and log the listening port

#### Scenario: Custom port via environment variable
- **WHEN** `SANDBOX_SERVER_PORT` is set to `9000`
- **THEN** the server SHALL listen on port 9000

### Requirement: Static file preview endpoint

The sandbox-server SHALL expose a `GET /preview/{path}` endpoint that serves files from the directory specified by the `PREVIEW_ROOT` environment variable, with Content-Security-Policy headers. See `report-preview-serving` spec for full requirements.

#### Scenario: Preview endpoint registered on server mux
- **WHEN** the sandbox-server starts with `PREVIEW_ROOT` set
- **THEN** the `/preview/` path SHALL be registered on the HTTP mux, served behind the logging middleware and emitting Content-Security-Policy headers

#### Scenario: Preview endpoint not registered when unconfigured
- **WHEN** the sandbox-server starts without `PREVIEW_ROOT` set
- **THEN** requests to `/preview/` SHALL return HTTP 404 with `{"error": "preview not configured"}`

### Requirement: Submit-and-return exec semantics

The sandbox-server SHALL accept `POST /exec` with a JSON body of `{ command, execId, cwd?, env?, timeoutSeconds? }`, spawn the command in a background goroutine, and return HTTP 202 immediately with `{ "execId": <execId>, "status": "started" }`. The HTTP response body SHALL NOT carry stdout, stderr, exit, or any streaming command output. The request handler SHALL return before the spawned command completes.

#### Scenario: Submit returns 202 before command exits
- **GIVEN** a sandbox-server is running and reachable
- **WHEN** `POST /exec` is called with body `{ "command": ["sleep", "10"], "execId": "wf1:step1:fn1" }`
- **THEN** the server SHALL respond with HTTP 202 and body `{ "execId": "wf1:step1:fn1", "status": "started" }` within 1 second
- **AND** the response SHALL complete before the `sleep` command exits

#### Scenario: Missing execId is rejected
- **WHEN** `POST /exec` is called with body `{ "command": ["echo", "hi"] }` (no `execId`)
- **THEN** the server SHALL respond with HTTP 400 and body `{ "error": "execId required" }`
- **AND** no command SHALL be spawned

#### Scenario: Submit body schema validation
- **WHEN** `POST /exec` is called with a malformed JSON body
- **THEN** the server SHALL respond with HTTP 400 and SHALL NOT spawn a command

### Requirement: execId idempotency dedup

The sandbox-server SHALL maintain an in-memory map of `execId → execState` (where `execState` is one of `running`, `completed`, `failed`). A `POST /exec` submission for an `execId` already present in the map SHALL NOT spawn a second command and SHALL return HTTP 202 with the existing state instead. The dedup map SHALL be TTL'd; the TTL SHALL be at least 1 hour after `execState` transitions out of `running`. The dedup map SHALL NOT be persisted across sandbox-server process restarts.

#### Scenario: Duplicate submit returns existing state without re-spawning
- **GIVEN** a previous `POST /exec` with `execId: "x1"` is in the `running` state
- **WHEN** a second `POST /exec` is received with the same `execId: "x1"`
- **THEN** the server SHALL respond with HTTP 202 and body `{ "execId": "x1", "status": "started" }`
- **AND** no second command process SHALL be spawned for `x1`

#### Scenario: Duplicate submit after completion returns completed state
- **GIVEN** a previous `POST /exec` with `execId: "x2"` has completed
- **WHEN** a second `POST /exec` is received with the same `execId: "x2"` within the dedup TTL
- **THEN** the server SHALL respond with HTTP 202 and body indicating the existing completion state
- **AND** no command SHALL be re-spawned

#### Scenario: execId map does not survive restart
- **GIVEN** sandbox-server has recorded `execId: "x3"` as completed
- **WHEN** the sandbox-server process restarts
- **THEN** the in-memory dedup map SHALL be empty
- **AND** a subsequent `POST /exec` with `execId: "x3"` SHALL spawn a new command

### Requirement: On-change tree-diff event callbacks

The sandbox-server's background executor SHALL diff the working tree (the bind-mounted sandbox workspace under the execId's cwd, or the configured workspace root if cwd is omitted) and SHALL POST a JSON event to `${CORTEX_BASE_URL}/sandbox/${execId}/event` only when the tree changes. Events SHALL be coalesced (sandbox-lifetime, on-change) — the executor SHALL NOT emit periodic heartbeats. Event payloads SHALL include the change kind (tool activity, file-tree, phase) and the relevant payload fields; they SHALL NOT include command stdout/stderr line streams.

#### Scenario: File create triggers a single event
- **GIVEN** a command is executing inside the sandbox
- **WHEN** the command writes a new file `/artifacts/x.txt`
- **THEN** the sandbox-server SHALL POST exactly one event to `${CORTEX_BASE_URL}/sandbox/${execId}/event` whose payload includes the new file path
- **AND** SHALL NOT emit a heartbeat event when no tree change has occurred

#### Scenario: Unchanged tree emits no events
- **GIVEN** a command is executing and the working tree has not changed for 60 seconds
- **WHEN** 60 seconds elapse
- **THEN** the sandbox-server SHALL NOT POST any event for `execId` during that window

#### Scenario: Multiple rapid changes are coalesced
- **GIVEN** a command writes three files within the coalescing window
- **WHEN** the executor next diffs the tree
- **THEN** the sandbox-server SHALL POST at most one event containing the cumulative tree-diff

### Requirement: Completion callback

When a spawned command exits (success, failure, killed, or timed-out), the sandbox-server SHALL POST a JSON completion payload to `${CORTEX_BASE_URL}/sandbox/${execId}/complete` containing `{ execId, exitCode, stdout, stderr, durationMs, provenance?, timedOut? }`. The completion POST SHALL be performed at most once per `execId`. The completion POST SHALL be performed regardless of exit code (zero or non-zero).

#### Scenario: Successful exit posts completion
- **GIVEN** a command spawned for `execId: "x1"` exits with code 0
- **WHEN** the process is reaped by sandbox-server
- **THEN** the sandbox-server SHALL POST to `${CORTEX_BASE_URL}/sandbox/x1/complete` with body containing `exitCode: 0`, the full `stdout`, `stderr`, and `durationMs`
- **AND** the dedup map entry for `x1` SHALL transition to `completed`

#### Scenario: Non-zero exit posts completion
- **GIVEN** a command spawned for `execId: "x2"` exits with code 1
- **WHEN** the process is reaped
- **THEN** the sandbox-server SHALL POST to `${CORTEX_BASE_URL}/sandbox/x2/complete` with body containing `exitCode: 1` and the stderr payload

#### Scenario: Completion posted exactly once per execId
- **GIVEN** a command spawned for `execId: "x3"` has exited
- **WHEN** the completion POST succeeds (HTTP 2xx response from Cortex)
- **THEN** the sandbox-server SHALL NOT POST `/complete` again for `execId: "x3"`

### Requirement: Per-sandbox HMAC signing of callbacks

The sandbox-server SHALL receive a per-sandbox `callbackSecret` (a high-entropy byte string) exactly once at sandbox creation, via the container's runtime configuration (env var or mounted file). The sandbox-server SHALL sign every outbound event and completion callback with `X-Sandbox-Signature: HMAC-SHA256(callbackSecret, "${execId}:${timestamp}:${sha256Hex(body)}")` and SHALL include an `X-Sandbox-Timestamp` header carrying the unix-seconds timestamp used in the signature. The raw `callbackSecret` SHALL NEVER appear in any callback body, query string, or response. The `callbackSecret` SHALL be held in memory only and SHALL NOT be persisted to disk.

#### Scenario: Event callback carries signature and timestamp headers
- **GIVEN** the sandbox-server holds a `callbackSecret` `S`
- **WHEN** the executor POSTs an event with body `B` for `execId: "x1"` at unix-second `T`
- **THEN** the request SHALL carry header `X-Sandbox-Signature` equal to the lowercase hex of `HMAC-SHA256(S, "x1:T:sha256Hex(B)")`
- **AND** the request SHALL carry header `X-Sandbox-Timestamp: T`
- **AND** the request body SHALL NOT include `S`

#### Scenario: Completion callback carries signature and timestamp headers
- **GIVEN** the sandbox-server holds a `callbackSecret`
- **WHEN** the executor POSTs the completion payload for `execId: "x1"`
- **THEN** the request SHALL carry `X-Sandbox-Signature` and `X-Sandbox-Timestamp` headers computed the same way as event callbacks

#### Scenario: Secret is not persisted
- **WHEN** sandbox-server has received and is using a `callbackSecret`
- **THEN** the secret SHALL NOT be written to any file under the sandbox filesystem
- **AND** SHALL NOT appear in any sandbox-server log line

### Requirement: Outbound callback retry with backoff

When an event or completion POST to `${CORTEX_BASE_URL}/sandbox/${execId}/{event|complete}` returns a 5xx response, a network error, or times out, the sandbox-server SHALL retry the POST with exponential backoff (starting at 250ms, doubling per attempt, capped at 30s) and SHALL continue retrying until the response is 2xx or the sandbox-server is terminated. The retry SHALL preserve the original `X-Sandbox-Timestamp` header (and therefore the original signature) so the receiver's freshness window is computed against the original send time. Each retry attempt SHALL be logged.

#### Scenario: 500 response triggers backoff retry
- **GIVEN** the first POST to `${CORTEX_BASE_URL}/sandbox/x1/event` returns HTTP 500
- **WHEN** sandbox-server retries
- **THEN** the second POST SHALL occur after at least 250ms
- **AND** the second POST SHALL carry the same `X-Sandbox-Signature` and `X-Sandbox-Timestamp` as the first
- **AND** retries SHALL continue with doubling intervals (capped at 30s) until a 2xx response is received

#### Scenario: Network error triggers retry
- **GIVEN** the first completion POST fails with a connection-refused error
- **WHEN** sandbox-server retries
- **THEN** retries SHALL continue with the same backoff schedule until a 2xx response is received

#### Scenario: 4xx response does not retry
- **GIVEN** the POST returns HTTP 4xx (e.g., 401, 404)
- **WHEN** sandbox-server processes the response
- **THEN** sandbox-server SHALL NOT retry the POST
- **AND** SHALL log the 4xx failure

### Requirement: Cortex base URL discovery

The sandbox-server SHALL read the Cortex base URL from the `CORTEX_BASE_URL` environment variable at startup. The base URL SHALL be the scheme+authority Cortex expects callbacks on (e.g., `https://cortex.example.com`). If `CORTEX_BASE_URL` is unset or empty, the sandbox-server SHALL refuse to start with an error log line, since outbound callbacks are mandatory in this protocol.

#### Scenario: Server starts with CORTEX_BASE_URL set
- **GIVEN** the container env contains `CORTEX_BASE_URL=https://cortex.example.com`
- **WHEN** sandbox-server starts
- **THEN** event POSTs SHALL target `https://cortex.example.com/sandbox/${execId}/event`
- **AND** completion POSTs SHALL target `https://cortex.example.com/sandbox/${execId}/complete`

#### Scenario: Missing CORTEX_BASE_URL aborts startup
- **GIVEN** the container env does not set `CORTEX_BASE_URL` (or sets it to the empty string)
- **WHEN** sandbox-server starts
- **THEN** the process SHALL exit non-zero with a log line indicating `CORTEX_BASE_URL` is required

### Requirement: callbackSecret receipt at sandbox creation

The sandbox-server SHALL read the per-sandbox `callbackSecret` from the `SANDBOX_CALLBACK_SECRET` environment variable at startup. The variable's value SHALL be treated as the raw secret bytes (base64-decoded if prefixed `base64:`, otherwise UTF-8). If `SANDBOX_CALLBACK_SECRET` is unset or empty, the sandbox-server SHALL refuse to start with an error log line.

#### Scenario: Server starts with SANDBOX_CALLBACK_SECRET set
- **GIVEN** the container env contains `SANDBOX_CALLBACK_SECRET=base64:<base64bytes>`
- **WHEN** sandbox-server starts
- **THEN** sandbox-server SHALL hold the decoded bytes in memory as the callback secret for the lifetime of the process

#### Scenario: Missing SANDBOX_CALLBACK_SECRET aborts startup
- **GIVEN** the container env does not set `SANDBOX_CALLBACK_SECRET`
- **WHEN** sandbox-server starts
- **THEN** the process SHALL exit non-zero with a log line indicating the secret is required

