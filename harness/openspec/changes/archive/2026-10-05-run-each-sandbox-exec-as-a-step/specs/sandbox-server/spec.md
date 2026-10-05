## ADDED Requirements

### Requirement: The exec-result endpoint serves incremental events by cursor

The sandbox-server MUST serve `GET /exec/{execId}?since={cursor}` with the JSON
body `{ status, events, cursor, truncated?, result? }`. `status` MUST be one of
`running`, `completed`, and `failed`. `events` MUST be the ring events whose
sequence number is above `since`, and an absent `since` reads as 0. `cursor` MUST
be the highest sequence number that the ring holds. `result` MUST be present only
when the exec is terminal, and it MUST be the exact completion payload of the
exec, with its provenance frame.

An unknown `execId` MUST give `404`. The request and the response MUST carry no
signature.

#### Scenario: An incremental fetch gives only the newer events

- **GIVEN** an exec whose ring holds the events up to sequence 5
- **WHEN** the host fetches `GET /exec/{execId}?since=3`
- **THEN** the response holds the events with the sequence numbers 4 and 5, and `cursor: 5`

#### Scenario: A terminal fetch holds the result

- **GIVEN** an exec that completed
- **WHEN** the host fetches the endpoint
- **THEN** the response holds `result` with the completion payload and the provenance frame

#### Scenario: The status is an enum

- **GIVEN** an exec whose command exited with code 1
- **WHEN** the host fetches the endpoint
- **THEN** `status` is `failed`, and `result.exitCode` is 1

#### Scenario: An unknown exec id is not found

- **WHEN** the host fetches `GET /exec/unknown?since=0`
- **THEN** the server gives `404`

### Requirement: On-change tree-diff events go to the ring

The background executor of the sandbox-server MUST diff the working tree: the
bind-mounted workspace under the `cwd` of the exec, or the configured workspace
root when the `cwd` is absent. The executor MUST append a JSON event to the ring
of the exec only when the tree changes. The executor MUST coalesce the events,
and it MUST NOT emit a heartbeat. An event payload MUST give the kind of the
change and its payload fields. An event payload MUST NOT hold a line of the
stdout or the stderr of the command.

#### Scenario: A file create appends one event

- **GIVEN** a command that runs inside the sandbox
- **WHEN** the command writes the new file `/artifacts/x.txt`
- **THEN** the sandbox-server appends exactly one event whose payload holds the new file path
- **AND** it appends no heartbeat when the tree does not change

#### Scenario: An unchanged tree gives no event

- **GIVEN** a command that runs, and a working tree that does not change for 60 seconds
- **WHEN** 60 seconds go by
- **THEN** the sandbox-server appends no event for the exec in that window

#### Scenario: Rapid changes are coalesced

- **GIVEN** a command that writes three files in the coalescing window
- **WHEN** the executor diffs the tree next
- **THEN** the sandbox-server appends at most one event, and that event holds the cumulative tree diff

### Requirement: The exec record holds the terminal result

When a spawned command exits, the sandbox-server MUST make the completion payload
`{ execId, exitCode, stdout, stderr, stdoutTruncated?, stderrTruncated?, stdoutTotalBytes?, stderrTotalBytes?, durationMs, provenance?, timedOut?, usage? }`. This
MUST occur on each exit: a success, a failure, a kill, and a timeout. The
sandbox-server MUST keep the payload in the record of the exec, and it MUST serve
the payload as `result` from the exec-result endpoint. The status of the record
MUST become `completed` for the exit code 0 and `failed` for each other exit. The
sandbox-server MUST send no request to the host.

#### Scenario: A successful exit gives a completed record

- **GIVEN** a command for `execId: "x1"` that exits with code 0
- **WHEN** the sandbox-server reaps the process
- **THEN** the record of `x1` is `completed`, and its result holds `exitCode: 0`, `stdout`, `stderr`, and `durationMs`

#### Scenario: A non-zero exit gives a failed record

- **GIVEN** a command for `execId: "x2"` that exits with code 1
- **WHEN** the sandbox-server reaps the process
- **THEN** the record of `x2` is `failed`, and its result holds `exitCode: 1` and the stderr

### Requirement: Root egress-firewall entrypoint for Docker

The sandbox image MUST give a root entrypoint that installs an egress-deny
firewall when the firewall flag is set, before the workload starts. Then it MUST
exec sandbox-server as the unprivileged workload uid. The Docker backend always
sets the flag. The entrypoint MUST do these steps:

1. Install `iptables` rules that permit loopback (`-o lo`) and established or
   related return traffic. Then set the `OUTPUT` policy to `DROP`.
2. Install the same rules with `ip6tables` when the container has an IPv6 stack,
   thus IPv6 is not a hole through the IPv4 firewall. A present IPv6 stack whose
   rules fail to install MUST stop the start.
3. Remove each capability that the container gave to the setup of the
   entrypoint. Clear the inheritable set and the bounding set before the exec of
   the workload. Thus the uid-1000 sandbox-server cannot change or flush the
   rules, and it cannot get a privilege again.
4. Exec sandbox-server as uid 1000. The entrypoint keeps no privilege.

When the flag is unset, the entrypoint MUST exec sandbox-server directly and
MUST NOT touch `iptables`. A K8s pod gets no flag, because a NetworkPolicy of
the deployment confines it. `iptables` MUST be present in the image.

The sandbox-server MUST enforce the promise of the flag. A server that runs as
root with the flag set shows that the firewall-and-drop chain did not run, for
example because an image overrides `ENTRYPOINT`. Then the server MUST refuse to
start, and the container fails at its start.

#### Scenario: The firewall is installed, then the workload drops its privilege

- **GIVEN** the firewall flag is set, and the container gives the setup capabilities of the entrypoint (`NET_ADMIN` among them)
- **WHEN** the container starts
- **THEN** the `OUTPUT` policy is `DROP`, with loopback and established traffic permitted
- **AND** sandbox-server runs as uid 1000, and it cannot flush the rules

#### Scenario: A new outbound connection is blocked, and the inbound poll works

- **GIVEN** the firewall is installed
- **WHEN** the host polls the published exec port, and the workload opens a new outbound connection
- **THEN** the inbound poll gets its answer on the established path, and the firewall drops the outbound connection

#### Scenario: An unset flag skips the firewall

- **GIVEN** the firewall flag is unset
- **WHEN** the container starts
- **THEN** the entrypoint execs sandbox-server directly and installs no `iptables` rule

#### Scenario: The flag with a drop that did not run refuses the start

- **GIVEN** the firewall flag is set, but the entrypoint chain did not run (the server starts as root)
- **WHEN** sandbox-server starts
- **THEN** it exits with a fatal confinement error, and it does not serve

#### Scenario: An IPv6 stack gets the same egress deny

- **GIVEN** the firewall flag is set, and the container has an IPv6 stack
- **WHEN** the container starts
- **THEN** the `ip6tables` `OUTPUT` policy is `DROP`, with loopback and established traffic permitted, the same as IPv4

## MODIFIED Requirements

### Requirement: sandbox-server binary and container entrypoint

The sandbox-server binary MUST be a statically-linked Go binary at
`/usr/local/bin/sandbox-server`. It MUST run as the workload process of the
container. The entrypoint starts it directly, or the root egress-firewall
entrypoint execs it on Docker after the drop to the workload uid. It MUST listen
on port 8765, or on the port that `SANDBOX_SERVER_PORT` gives.

It MUST serve the health, exec (submit and result), and preview endpoints. It
MUST NOT serve a kill endpoint. It MUST send no request to the host.

#### Scenario: Server starts as container entrypoint

- **WHEN** the sandbox container starts
- **THEN** the server listens on `0.0.0.0:8765` and logs the listening port

#### Scenario: Custom port via environment variable

- **WHEN** `SANDBOX_SERVER_PORT` is set to `9000`
- **THEN** the server listens on port 9000

#### Scenario: No kill endpoint is served

- **WHEN** a request goes to a `/exec/{id}/kill` path
- **THEN** the server has no handler that stops a running command

### Requirement: Submit-and-return exec semantics

The sandbox-server MUST accept `POST /exec` with a JSON body of
`{ command, execId, cwd?, env?, timeoutSeconds?, stdoutByteCap?, stderrByteCap? }`.
It MUST spawn the command in a background goroutine, and it MUST return HTTP 202
at once with `{ "execId": <execId>, "status": "running" }`. The HTTP response
body MUST NOT carry stdout, stderr, exit, or any streamed command output. The
request handler MUST return before the spawned command completes. The request
carries no signature.

The server MUST cap the request body that it buffers at a fixed, generous limit.
The limit is generous because the former write path of `write_file` sent whole
files base64-inflated inside the command array. The server MUST reject a larger
body with HTTP 413, and it MUST spawn nothing. Thus the cap bounds the memory
cost of each peer that can reach the port.

#### Scenario: Submit returns 202 before command exits

- **GIVEN** a sandbox-server that is up and reachable
- **WHEN** `POST /exec` is called with the body `{ "command": ["sleep", "10"], "execId": "wf1:4" }`
- **THEN** the server responds with HTTP 202 and the body `{ "execId": "wf1:4", "status": "running" }` within 1 second
- **AND** the response completes before the `sleep` command exits

#### Scenario: Missing execId is rejected

- **WHEN** `POST /exec` is called with the body `{ "command": ["echo", "hi"] }` (no `execId`)
- **THEN** the server responds with HTTP 400 and the body `{ "error": "execId required" }`
- **AND** no command spawns

#### Scenario: Submit body schema validation

- **WHEN** `POST /exec` is called with a malformed JSON body
- **THEN** the server responds with HTTP 400 and spawns no command

#### Scenario: Oversized submit is rejected

- **WHEN** `POST /exec` arrives with a body that is larger than the cap of the server
- **THEN** the server responds HTTP 413 and spawns no command

### Requirement: execId idempotency dedup

The sandbox-server MUST keep an in-memory map of `execId` to the exec record.
The status of a record is one of `running`, `completed`, and `failed`. A
`POST /exec` for an `execId` that the map holds MUST NOT spawn a second command.
It MUST return HTTP 202 with the status of the existing record.

The map MUST keep each record for the life of the process, with no TTL. Thus a recovered host
step that submits again finds the record. The map MUST NOT persist across a
restart of the sandbox-server process.

#### Scenario: Duplicate submit returns existing state without re-spawning

- **GIVEN** a previous `POST /exec` with `execId: "x1"` whose record is `running`
- **WHEN** a second `POST /exec` arrives with the same `execId: "x1"`
- **THEN** the server responds with HTTP 202 and the body `{ "execId": "x1", "status": "running" }`
- **AND** no second command process spawns for `x1`

#### Scenario: Duplicate submit after completion returns completed state

- **GIVEN** a previous `POST /exec` with `execId: "x2"` that completed
- **WHEN** a second `POST /exec` arrives with the same `execId: "x2"`, at any time later in the life of the process
- **THEN** the server responds with HTTP 202 and the status of the existing record
- **AND** no command spawns again, and a poll of `x2` gives the first result

#### Scenario: execId map does not survive restart

- **GIVEN** a sandbox-server that recorded `execId: "x3"` as completed
- **WHEN** the sandbox-server process restarts
- **THEN** the in-memory map is empty
- **AND** a later `POST /exec` with `execId: "x3"` spawns a new command

### Requirement: Bounded per-exec event ring buffer

The sandbox-server MUST keep the progress events of each exec in a bounded
in-memory ring, keyed by `execId`, beside the exec record. Each appended event
MUST get a per-exec sequence number that only increases, and that number is the
poll cursor. When the ring is full, the server MUST drop the oldest event and
record a `truncated` marker. Thus a poll response can show that earlier events
were dropped. The ring MUST have the same lifetime as the exec record, and it
MUST NOT persist across a restart.

#### Scenario: Events accumulate with increasing sequence numbers

- **GIVEN** an exec that emits three tree-change events
- **WHEN** the server appends them to the ring
- **THEN** each carries a sequence number above the one before it

#### Scenario: Ring overflow drops oldest and marks truncated

- **GIVEN** an exec that emits more events than the ring holds
- **WHEN** the ring overflows
- **THEN** the server drops the oldest events and sets the `truncated` marker for that exec

## REMOVED Requirements

### Requirement: Transport mode selects result delivery

**Reason**: One protocol remains: the host submits and polls, and the sandbox initiates nothing. The server reads no `SANDBOX_TRANSPORT`.

**Migration**: Remove `SANDBOX_TRANSPORT` from the container env.

### Requirement: Poll-mode exec-result endpoint serves incremental events by cursor

**Reason**: The endpoint has no mode, and its responses carry no signature.

**Migration**: Refer to "The exec-result endpoint serves incremental events by cursor".

### Requirement: Root egress-firewall entrypoint for Docker poll mode

**Reason**: Docker has no poll mode now. The Docker backend always sets the firewall flag.

**Migration**: Refer to "Root egress-firewall entrypoint for Docker".

### Requirement: On-change tree-diff event callbacks

**Reason**: No callback exists. Each event goes to the ring of the exec.

**Migration**: Refer to "On-change tree-diff events go to the ring".

### Requirement: Completion callback

**Reason**: No callback exists. The exec record holds the terminal result, and the poll serves it.

**Migration**: Refer to "The exec record holds the terminal result".

### Requirement: Per-sandbox HMAC signing of callbacks

**Reason**: The per-sandbox secret, the request signature, and the response signature are removed. Confinement keeps a different peer away from the exec endpoints (see the harness-sandbox-exec spec).

**Migration**: Remove `SANDBOX_CALLBACK_SECRET` from the container env.

### Requirement: Outbound callback retry with backoff

**Reason**: The sandbox-server sends no request to the host.

**Migration**: None.

### Requirement: Cortex base URL discovery

**Reason**: The sandbox-server sends no request to the host, thus it needs no host URL.

**Migration**: Remove `CORTEX_BASE_URL` from the container env.

### Requirement: callbackSecret receipt at sandbox creation

**Reason**: No secret exists.

**Migration**: Remove `SANDBOX_CALLBACK_SECRET` from the container env.
