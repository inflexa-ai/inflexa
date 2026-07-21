# harness-sandbox-exec — delta

## ADDED Requirements

### Requirement: Transport mode selects how exec results reach the host

The harness SHALL expose a `SandboxTransport` value `"poll" | "callback"`, supplied
by the embedder at the composition root and carried into each sandbox as the
`SANDBOX_TRANSPORT` environment variable. The mode SHALL be backend-independent
(Docker and K8s both honour it) and SHALL change only how the terminal result and
progress events reach the host — not command execution, provenance, or auth. The
OSS default SHALL be `poll`. Inbound request signing SHALL apply in both modes.

#### Scenario: Embedder selects poll (default)

- **GIVEN** an embedder configuring `SandboxTransport = "poll"` (or the OSS default)
- **WHEN** a sandbox is created
- **THEN** the container SHALL receive `SANDBOX_TRANSPORT=poll`
- **AND** the embedder SHALL start no callback ingress and advertise no `CORTEX_BASE_URL`

#### Scenario: Embedder selects callback

- **GIVEN** an embedder configuring `SandboxTransport = "callback"`
- **WHEN** a sandbox is created
- **THEN** the container SHALL receive `SANDBOX_TRANSPORT=callback` and a `CORTEX_BASE_URL`
- **AND** the embedder SHALL run a callback ingress

### Requirement: In poll mode awaitExec polls a signed cursor endpoint

In poll mode `awaitExec` SHALL NOT use `DBOS.recv` or a per-exec topic. It SHALL
loop durable pull steps named `sandbox.poll-exec-result.${execId}.${n}` on a
two-phase cadence — a fast interval for the first attempts (short execs return
within one snappy interval) backing off to a slower interval thereafter (an
hours-long exec polls sustainably) — derived from the attempt counter alone so
the schedule replays identically. Each poll fetches
`GET /exec/{execId}?since={cursor}` and receives a signed
`{ status, events[], cursor, result? }`. The loop SHALL verify the body with the
per-sandbox HMAC exactly as a pulled result is verified, forward events newer than
`cursor` via `emit`, advance `cursor`, and return `result` when terminal. The
newer-than-cursor filter SHALL be applied by the loop itself: the signature covers
the response body but not the request's `since`, so any validly-signed snapshot
verifies against any poll, and a replayed or crossed response MUST NOT re-emit
already-delivered events. A gap between the local cursor and the next served
sequence — events shed by the sandbox's bounded ring before delivery — SHALL be
surfaced as an advisory warning; the terminal result, not the event stream,
remains the authoritative outcome. A forged or stale signature SHALL throw
`HardCancelError`. The loop SHALL be bounded by `step.timeout`, and SHALL poll
once more upon crossing the deadline before declaring a timeout, so a result
sitting completed in the sandbox is returned rather than discarded. A recovered
workflow SHALL resume polling from its current host identity without a lost
result — the recovery wedge (#41) does not apply to poll.

#### Scenario: Poll returns the terminal result

- **GIVEN** a poll-mode exec that has completed
- **WHEN** `awaitExec` polls `GET /exec/{execId}?since={cursor}`
- **THEN** the signed response carries `result`, and `awaitExec` verifies and returns it

#### Scenario: Incremental events are forwarded once

- **GIVEN** a poll-mode exec emitting events between polls
- **WHEN** `awaitExec` polls with the last `cursor`
- **THEN** only events newer than `cursor` SHALL be emitted, and `cursor` advanced

#### Scenario: A forged poll response hard-cancels

- **GIVEN** a poll response whose signature does not verify against the per-sandbox secret
- **WHEN** `awaitExec` receives it
- **THEN** `awaitExec` SHALL throw `HardCancelError` and the workflow SHALL be cancelled without retry

#### Scenario: A recovered workflow resumes polling

- **GIVEN** a poll-mode exec whose host restarts mid-run
- **WHEN** the workflow recovers under the same `executorID`
- **THEN** the poll loop SHALL continue against the sandbox from the recovered host, and the terminal result SHALL still be retrieved

#### Scenario: A replayed snapshot does not duplicate events

- **GIVEN** a validly-signed poll response re-serving events at or below the loop's local cursor
- **WHEN** `awaitExec` processes it
- **THEN** only events newer than the local cursor SHALL be emitted

#### Scenario: Events shed by the ring are surfaced

- **GIVEN** a poll response whose first served sequence leaves a gap above the local cursor (or whose cursor advanced with no events served)
- **WHEN** `awaitExec` processes it
- **THEN** the loop SHALL emit an advisory warning naming the lost range and continue

#### Scenario: The deadline check polls once more before timing out

- **GIVEN** a poll-mode exec whose deadline has been crossed
- **WHEN** the loop observes the crossing
- **THEN** it SHALL issue one more poll and return the terminal result if that poll carries one, throwing `ExecTimeoutError` only otherwise

#### Scenario: The cadence backs off for long execs

- **GIVEN** a poll-mode exec still running after the fast-phase attempts are spent
- **WHEN** the loop schedules its next poll
- **THEN** it SHALL sleep the slow-phase interval, and the schedule SHALL be a pure function of the attempt counter

## MODIFIED Requirements

### Requirement: A terminal result is retrievable after a lost callback

`GET /exec/{execId}` SHALL return the exec's terminal result signed fresh at
request time so a host that was not listening when the exec finished — or that
restarted onto a new identity — can still retrieve it; a still-running exec SHALL
answer without a `result`. In **poll mode** the endpoint SHALL additionally accept
`?since={cursor}` and return `{ status, events[], cursor, result? }`, where
`events` are the buffered progress events newer than `cursor`, `cursor` is the new
high-water mark, and events are served from a **bounded ring** that sets a
`truncated` marker when it drops the oldest. In **callback mode** this endpoint
remains the recovery backstop for a lost push. In both cases the served bytes are
the ones a callback would have carried, so the provenance frame survives the
retrieval path and one verification path serves poll and callback.

#### Scenario: A completed exec is retrievable regardless of transport

- **GIVEN** a completed exec
- **WHEN** the host fetches `GET /exec/{execId}` (poll: with `?since`)
- **THEN** the response SHALL be signed fresh and carry the terminal `result` with its provenance frame

#### Scenario: A running exec is unsigned/without result and does not terminate the loop

- **GIVEN** an exec still running
- **WHEN** the host fetches the endpoint
- **THEN** the response SHALL carry no `result`, and the loop SHALL keep waiting

### Requirement: The exec endpoints authenticate inbound requests by signature

The exec endpoints — `POST /exec` and `GET /exec/{execId}` — SHALL require a valid
`X-Sandbox-Signature` / `X-Sandbox-Timestamp` pair computed as
`HMAC-SHA256(callbackSecret, "${execId}:${timestamp}:${sha256Hex(body)}")`, the
same construction as the results the sandbox returns, and SHALL verify it against
the freshness window. This SHALL hold in **both** transport modes: it authenticates
the host→sandbox direction independent of how results flow back. `POST /exec` SHALL
sign the request body; `GET /exec/{execId}` SHALL sign an empty body. A missing,
malformed, forged, or stale signature SHALL be rejected with `401` before any
command is spawned or any result disclosed. Authentication SHALL be a request
signature, not a static bearer, so any cleartext hop can forward or drop a request
but never mint another. Because the check tests possession of the per-sandbox
secret, a sibling sandbox on the shared analysis network — holding only its own
secret — SHALL NOT be able to authenticate to this sandbox's exec endpoints. The
server SHALL expose no `POST /exec/{pid}/kill` route. `GET /health` SHALL remain
unauthenticated.

#### Scenario: An unsigned request is rejected

- **GIVEN** a running sandbox-server in either mode
- **WHEN** `POST /exec` or `GET /exec/{execId}` arrives with no signature headers
- **THEN** the server SHALL respond `401` and neither spawn the command nor disclose output

#### Scenario: A sibling cannot authenticate with its own secret

- **GIVEN** two sandboxes of one analysis, each with a distinct `callbackSecret`, sharing a network
- **WHEN** one signs a request to the other's `/exec` with its own secret
- **THEN** the signature SHALL NOT verify and the request SHALL be rejected `401`

## REMOVED Requirements

### Requirement: The Docker backend confines the sandbox behind a gateway

**Reason**: The gateway existed only to reconcile a contradiction — carry the
outbound callback while an `--internal` network blocked egress. Poll mode removes
the outbound callback entirely (the sandbox initiates nothing), and callback mode
permits egress directly, so neither mode needs a gateway or an `--internal`
bridge. Confinement in poll mode is provided by an in-container egress firewall
(see the `docker-sandbox-provider` delta); callback mode permits scoped egress.
The requirement and the `sandbox-server gateway` subcommand are removed.
