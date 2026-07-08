# harness-runtime — delta

## MODIFIED Requirements

### Requirement: On-demand composition of the embedded harness runtime

The system SHALL provide a composition module that boots the embedded harness runtime
on first use and reuses it for the remainder of the process (module singleton). Boot
SHALL sequence: ensure Postgres readiness (via the infra module); **in callback
transport mode only**, start the exec-callback listener; register the durable
workflows with their fully-realized deps — the child sandbox-step workflow BEFORE the
execute-analysis parent (the parent's deps close over the registered child callable),
plus the data-profile workflow and the sandbox-hygiene scheduled workflows — then
launch DBOS, so every registration lands in one pre-launch cohort. The CLI runs in
**poll** transport mode by default, in which the sandbox is polled for results and no
callback listener is bound. Passive flows (bare `inflexa` launch, TUI startup) SHALL
NOT boot the runtime. A second boot request SHALL return the existing runtime without
re-registering or re-launching.

#### Scenario: First trigger boots the runtime (poll mode, the default)

- **WHEN** a data-profile or analysis-run launch is requested and the runtime has not been booted
- **THEN** Postgres readiness is ensured, all workflows are registered (sandbox-step before execute-analysis), and DBOS launches — in that order — and NO callback listener is bound

#### Scenario: Callback mode additionally binds the listener

- **WHEN** the runtime boots in callback transport mode
- **THEN** the exec-callback listener starts after Postgres readiness and before registration

#### Scenario: Subsequent triggers reuse the runtime

- **WHEN** a second launch is requested in the same process
- **THEN** no re-registration or re-launch occurs and the existing runtime serves the trigger

#### Scenario: Unavailable Postgres blocks boot with actionable guidance

- **WHEN** the runtime boot cannot reach a ready Postgres
- **THEN** boot fails with the infra module's actionable error (e.g. pointing at setup) and DBOS is not launched

#### Scenario: One registration cohort

- **WHEN** the runtime boots and DBOS recovery resumes an in-flight workflow of any registered kind (profile, run parent, run child)
- **THEN** the workflow is found by its registered name — no workflow the cli can trigger is registered after launch

### Requirement: Exec-callback ingress bridges sandbox HTTP callbacks to DBOS topics

In **callback** transport mode the runtime SHALL host a loopback-only HTTP listener
accepting `POST /sandbox/{execId}/{kind}` for `kind` ∈ {`event`, `complete`}. Each
accepted request SHALL be enveloped as `{payload, payloadRaw, signature, timestamp}`
from the body and the `X-Sandbox-Signature`/`X-Sandbox-Timestamp` headers (absent
headers as null), with `complete` payloads wrapped in the done-marker shape, and
delivered to the workflow derived from the execId via the harness's exec-event
delivery helper (never a cli-side `DBOS.send` — the SDK is module-singleton state and
a second copy is un-launched). The listener SHALL NOT verify HMAC signatures
(verification is the workflow body's job) and SHALL NOT hold callback secrets. An
execId from which no workflow id can be derived SHALL yield a 4xx (the sandbox-server
gives up); a failed send SHALL yield a 5xx (the sandbox-server retries). The sandbox
client's `cortexBaseUrl` SHALL be a URL under which sandbox containers reach this
listener. In **poll** transport mode (the CLI default) the runtime SHALL bind NO such
listener and SHALL advertise an empty `cortexBaseUrl` — the sandbox initiates nothing
and is polled for results instead.

#### Scenario: Poll mode binds no listener

- **WHEN** the runtime boots in poll transport mode
- **THEN** no `/sandbox/{execId}/{kind}` listener is bound and the sandbox client's `cortexBaseUrl` is empty

#### Scenario: Event callback reaches the awaiting workflow (callback mode)

- **WHEN** the sandbox-server POSTs an exec event to `/sandbox/{execId}/event`
- **THEN** the enveloped message is sent to topic `exec-event:{execId}` of the workflow derived from the execId and the listener replies 2xx

#### Scenario: Completion callback is wrapped as a done-marker (callback mode)

- **WHEN** the sandbox-server POSTs to `/sandbox/{execId}/complete`
- **THEN** the delivered envelope's payload is the done-marker form carrying the exec result

#### Scenario: Malformed execId is a permanent rejection (callback mode)

- **WHEN** a POST arrives whose execId yields no derivable workflow id
- **THEN** the listener replies 4xx and delivers nothing
