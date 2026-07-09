# sandbox-server — delta

## ADDED Requirements

### Requirement: Transport mode selects result delivery

The sandbox-server SHALL read `SANDBOX_TRANSPORT` (`poll` | `callback`) at startup,
defaulting to `poll` when unset. The mode SHALL select how a command's progress
events and terminal result reach the host and SHALL NOT change command execution,
idempotency, provenance, or inbound request authentication:

- In **poll mode** the executor SHALL make no outbound HTTP request. It SHALL NOT
  construct a callback client and SHALL NOT read or require `CORTEX_BASE_URL`.
  Progress events SHALL be appended to the per-exec event ring, and both events and
  the terminal result SHALL be served on demand from the exec-result endpoint.
- In **callback mode** the executor SHALL POST signed event and completion
  callbacks as specified by the callback requirements, and SHALL require
  `CORTEX_BASE_URL`.

In both modes the sandbox-server SHALL require `SANDBOX_CALLBACK_SECRET` (it signs
served/pushed bodies and verifies inbound request signatures) and SHALL enforce
inbound request signing on the exec endpoints.

#### Scenario: Poll mode makes no outbound request

- **GIVEN** `SANDBOX_TRANSPORT=poll`
- **WHEN** a command executes and produces tree changes and then exits
- **THEN** the sandbox-server SHALL POST nothing to any `CORTEX_BASE_URL`
- **AND** the events and the terminal result SHALL be retrievable from the exec-result endpoint

#### Scenario: Callback mode posts as before

- **GIVEN** `SANDBOX_TRANSPORT=callback`
- **WHEN** a command executes and exits
- **THEN** the sandbox-server SHALL POST signed event and completion callbacks

#### Scenario: Default mode is poll

- **GIVEN** `SANDBOX_TRANSPORT` is unset
- **WHEN** the sandbox-server starts
- **THEN** it SHALL run in poll mode and SHALL NOT require `CORTEX_BASE_URL`

### Requirement: Bounded per-exec event ring buffer

In poll mode the sandbox-server SHALL retain each exec's progress events in a
bounded in-memory ring keyed by `execId`, alongside the existing exec state. Each
appended event SHALL be assigned a monotonically increasing per-exec sequence
number that serves as the poll cursor. When the ring is full the oldest event
SHALL be dropped and a `truncated` marker SHALL be recorded so a poll response can
signal that earlier events were shed. The ring SHALL follow the same TTL and
non-persistence rules as the dedup map (cleared on process restart).

#### Scenario: Events accumulate with increasing sequence numbers

- **GIVEN** a poll-mode exec that emits three tree-change events
- **WHEN** they are appended to the ring
- **THEN** each SHALL carry a strictly increasing sequence number

#### Scenario: Ring overflow drops oldest and marks truncated

- **GIVEN** a poll-mode exec that emits more events than the ring capacity
- **WHEN** the ring overflows
- **THEN** the oldest event(s) SHALL be dropped and a `truncated` marker SHALL be set for that exec

### Requirement: Poll-mode exec-result endpoint serves incremental events by cursor

The sandbox-server SHALL serve `GET /exec/{execId}?since={cursor}` returning a JSON
body `{ status, events, cursor, truncated?, result? }`, where `events` are the ring
events with a sequence number greater than `since` (from 0 when `since` is absent),
`cursor` is the highest sequence number now served, `status` is the exec state, and
`result` is present only once the exec is terminal (carrying the same completion
payload and provenance frame a completion callback would carry). The whole response
body SHALL be signed with `X-Sandbox-Signature` / `X-Sandbox-Timestamp` over the
same `HMAC-SHA256(callbackSecret, "${execId}:${timestamp}:${sha256Hex(body)}")`
construction used for callbacks, minted fresh at request time. The request SHALL be
subject to inbound signature authentication like every exec endpoint. An unknown
`execId` SHALL return 404.

#### Scenario: Incremental fetch returns only newer events

- **GIVEN** a poll-mode exec whose ring holds events up to sequence 5
- **WHEN** the host fetches `GET /exec/{execId}?since=3` with a valid inbound signature
- **THEN** the response SHALL carry events with sequence 4 and 5, `cursor: 5`, and SHALL be signed fresh

#### Scenario: Terminal fetch carries the signed result

- **GIVEN** a poll-mode exec that has completed
- **WHEN** the host fetches the endpoint
- **THEN** the response SHALL include `result` with the completion payload and provenance frame, signed fresh

#### Scenario: Unsigned poll request is rejected

- **WHEN** `GET /exec/{execId}?since=0` arrives without a valid inbound signature
- **THEN** the server SHALL respond 401 and disclose no events or result

### Requirement: Root egress-firewall entrypoint for Docker poll mode

The sandbox image SHALL provide a root entrypoint that, when a Docker-poll env flag
is set, installs an egress-deny firewall before the workload starts and then execs
sandbox-server as the unprivileged workload uid. It SHALL:

1. Install `iptables` rules allowing loopback (`-o lo`) and established/related
   return traffic, then set the `OUTPUT` policy to `DROP`.
2. Mirror the same rules with `ip6tables` when the container has an IPv6 stack
   (a dual-stack bridge), so IPv6 is not a hole through the IPv4 firewall; a
   present IPv6 stack whose rules cannot be installed SHALL abort the start.
3. Drop `CAP_NET_ADMIN` from the process before exec'ing the workload, so the
   uid-1000 sandbox-server cannot alter or flush the rules.
4. Exec sandbox-server as uid 1000 (the entrypoint holds no long-lived privilege).

When the flag is unset (K8s, or callback mode where confinement is by
NetworkPolicy) the entrypoint SHALL exec sandbox-server directly without touching
iptables. `iptables` SHALL be present in the image.

sandbox-server SHALL enforce the flag's promise fail-closed: when the firewall
flag is set but the server finds itself running as root — proof the entrypoint's
firewall-and-drop chain did not run, e.g. an image that overrides `ENTRYPOINT` —
it SHALL refuse to start, turning a silently unconfined container into a loud
create-time failure.

#### Scenario: Firewall installed then workload de-privileged (Docker poll)

- **GIVEN** the Docker-poll firewall flag is set and the container has `CAP_NET_ADMIN`
- **WHEN** the container starts
- **THEN** `OUTPUT` policy SHALL be `DROP` with loopback and established traffic allowed
- **AND** sandbox-server SHALL run as uid 1000 and SHALL be unable to flush the rules

#### Scenario: New outbound connection blocked, inbound poll works

- **GIVEN** the firewall is installed
- **WHEN** the host polls the published exec port and the workload attempts a new outbound connection
- **THEN** the inbound poll SHALL succeed over the established path and the outbound connection SHALL be dropped

#### Scenario: Flag unset skips the firewall

- **GIVEN** the Docker-poll firewall flag is unset
- **WHEN** the container starts
- **THEN** the entrypoint SHALL exec sandbox-server directly without installing iptables rules

#### Scenario: Firewall flag with an unexecuted drop refuses startup

- **GIVEN** the firewall flag is set but the entrypoint chain did not run (the server starts as root)
- **WHEN** sandbox-server starts
- **THEN** it SHALL exit with a fatal confinement error instead of serving

#### Scenario: IPv6 stack gets the same egress deny

- **GIVEN** the firewall flag is set and the container has an IPv6 stack
- **WHEN** the container starts
- **THEN** the `ip6tables` `OUTPUT` policy SHALL be `DROP` with loopback and established traffic allowed, mirroring IPv4

## MODIFIED Requirements

### Requirement: Submit-and-return exec semantics

The sandbox-server SHALL accept `POST /exec` with a JSON body of `{ command, execId, cwd?, env?, timeoutSeconds? }`, spawn the command in a background goroutine, and return HTTP 202 immediately with `{ "execId": <execId>, "status": "started" }`. The HTTP response body SHALL NOT carry stdout, stderr, exit, or any streaming command output. The request handler SHALL return before the spawned command completes.

The server SHALL cap the request body it buffers at a fixed, generous limit
(sized for `write_file` payloads, which ship whole files base64-inflated inside
the command array) and SHALL reject a larger body with HTTP 413 without spawning
anything — the body is read before its signature can be verified (the signature
covers the bytes), so the cap, not the auth check, is what bounds the memory
cost of an unauthenticated peer able to reach the port.

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

#### Scenario: Oversized submit is rejected
- **WHEN** `POST /exec` arrives with a body exceeding the server's cap
- **THEN** the server SHALL respond HTTP 413 and SHALL NOT spawn a command

### Requirement: sandbox-server binary and container entrypoint

The sandbox-server binary SHALL be a statically-linked Go binary located at
`/usr/local/bin/sandbox-server`. It SHALL run as the container's workload process —
started directly as the entrypoint, or exec'd by the root egress-firewall entrypoint
in Docker poll mode after it de-privileges to the workload uid — and listen on port
8765 (or the port specified by `SANDBOX_SERVER_PORT`). It SHALL serve the health,
exec (submit and result), and preview endpoints. It SHALL NOT serve any kill
endpoint.

#### Scenario: Server starts as container entrypoint
- **WHEN** the sandbox container starts
- **THEN** the server SHALL listen on `0.0.0.0:8765` and log the listening port

#### Scenario: Custom port via environment variable
- **WHEN** `SANDBOX_SERVER_PORT` is set to `9000`
- **THEN** the server SHALL listen on port 9000

#### Scenario: No kill endpoint is served
- **WHEN** any request is made to a `/exec/{id}/kill` path
- **THEN** the server SHALL NOT expose a handler that terminates a running command

### Requirement: On-change tree-diff event callbacks

The sandbox-server's background executor SHALL diff the working tree (the
bind-mounted sandbox workspace under the execId's cwd, or the configured workspace
root if cwd is omitted) and SHALL surface a JSON event only when the tree changes.
Events SHALL be coalesced (sandbox-lifetime, on-change) — the executor SHALL NOT
emit periodic heartbeats. Event payloads SHALL include the change kind (tool
activity, file-tree, phase) and the relevant payload fields; they SHALL NOT include
command stdout/stderr line streams. How an event is surfaced depends on the
transport mode: in **callback mode** the executor SHALL POST it to
`${CORTEX_BASE_URL}/sandbox/${execId}/event`; in **poll mode** the executor SHALL
append it to the per-exec event ring for retrieval via the exec-result endpoint.

#### Scenario: File create triggers a single event
- **GIVEN** a command is executing inside the sandbox
- **WHEN** the command writes a new file `/artifacts/x.txt`
- **THEN** the sandbox-server SHALL surface exactly one event whose payload includes the new file path (POSTed in callback mode, appended to the ring in poll mode)
- **AND** SHALL NOT emit a heartbeat event when no tree change has occurred

#### Scenario: Unchanged tree emits no events
- **GIVEN** a command is executing and the working tree has not changed for 60 seconds
- **WHEN** 60 seconds elapse
- **THEN** the sandbox-server SHALL surface no event for `execId` during that window

#### Scenario: Multiple rapid changes are coalesced
- **GIVEN** a command writes three files within the coalescing window
- **WHEN** the executor next diffs the tree
- **THEN** the sandbox-server SHALL surface at most one event containing the cumulative tree-diff

### Requirement: Completion callback

The sandbox-server SHALL produce a JSON completion payload
`{ execId, exitCode, stdout, stderr, durationMs, provenance?, timedOut? }` when a
spawned command exits (success, failure, killed, or timed-out). In
**callback mode** it SHALL POST this payload to
`${CORTEX_BASE_URL}/sandbox/${execId}/complete` at most once per `execId`,
regardless of exit code. In **poll mode** it SHALL retain the payload as the exec's
terminal `result`, served (signed) from the exec-result endpoint, and SHALL POST
nothing. In both modes the payload SHALL be produced regardless of exit code (zero
or non-zero).

#### Scenario: Successful exit yields completion
- **GIVEN** a command spawned for `execId: "x1"` exits with code 0
- **WHEN** the process is reaped by sandbox-server
- **THEN** the completion payload SHALL contain `exitCode: 0`, the full `stdout`, `stderr`, and `durationMs` — POSTed to `/complete` in callback mode, retained as the served terminal result in poll mode
- **AND** the dedup map entry for `x1` SHALL transition to `completed`

#### Scenario: Non-zero exit yields completion
- **GIVEN** a command spawned for `execId: "x2"` exits with code 1
- **WHEN** the process is reaped
- **THEN** the completion payload SHALL contain `exitCode: 1` and the stderr payload

#### Scenario: Callback-mode completion posted exactly once per execId
- **GIVEN** callback mode and a command spawned for `execId: "x3"` has exited
- **WHEN** the completion POST succeeds (HTTP 2xx response from Cortex)
- **THEN** the sandbox-server SHALL NOT POST `/complete` again for `execId: "x3"`

### Requirement: Cortex base URL discovery

In callback mode the sandbox-server SHALL read the Cortex base URL from the
`CORTEX_BASE_URL` environment variable at startup; it SHALL be the scheme+authority
Cortex expects callbacks on (e.g., `https://cortex.example.com`), and if unset or
empty the sandbox-server SHALL refuse to start with an error log line, since
outbound callbacks are mandatory in that mode. In poll mode the sandbox-server SHALL
NOT read or require `CORTEX_BASE_URL` and SHALL start without it.

#### Scenario: Callback mode starts with CORTEX_BASE_URL set
- **GIVEN** `SANDBOX_TRANSPORT=callback` and the container env contains `CORTEX_BASE_URL=https://cortex.example.com`
- **WHEN** sandbox-server starts
- **THEN** event POSTs SHALL target `https://cortex.example.com/sandbox/${execId}/event`
- **AND** completion POSTs SHALL target `https://cortex.example.com/sandbox/${execId}/complete`

#### Scenario: Callback mode missing CORTEX_BASE_URL aborts startup
- **GIVEN** `SANDBOX_TRANSPORT=callback` and the container env does not set `CORTEX_BASE_URL` (or sets it empty)
- **WHEN** sandbox-server starts
- **THEN** the process SHALL exit non-zero with a log line indicating `CORTEX_BASE_URL` is required

#### Scenario: Poll mode starts without CORTEX_BASE_URL
- **GIVEN** `SANDBOX_TRANSPORT=poll` and the container env does not set `CORTEX_BASE_URL`
- **WHEN** sandbox-server starts
- **THEN** the server SHALL start normally and serve the exec-result endpoint
