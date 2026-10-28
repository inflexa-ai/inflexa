## ADDED Requirements

### Requirement: RunAuthorizer supports out-of-band revocation by the persisted mandate id

`RunAuthorizer` SHALL expose `revokeByMandateId(ref: { mandateId: string; auth: AuthContext }, reason: string)` for paths that hold no `RunSession` — external cancellation, where only the mandate id survives on `cortex_runs`. The `ref` SHALL carry the caller's opaque `AuthContext`; the harness never inspects it. It is a notice. The local/OSS realization SHALL no-op, because it records no reference.

#### Scenario: Local authorizer no-ops

- **WHEN** `createLocalRunAuthorizer().revokeByMandateId({ mandateId, auth }, reason)` is called
- **THEN** it resolves without side effects

#### Scenario: Out-of-band cancel revokes by the mandate id

- **WHEN** the run canceler converges a run whose row carries a `mandate_id`
- **THEN** it calls `revokeByMandateId` with that id and the cancelling session's `auth`, never reconstructing a `RunSession`

### Requirement: The run session is a durable reference, and the authorizer follows the pause of the work

A `RunSession` SHALL hold a durable reference to the run credential, not a time-bound secret, because a run and a profile have no time limit. `RunAuthorizer` SHALL expose `suspend(runSession, reason)`, a notice for work that waits for a person, and `renew(runSession, auth)`, a gate for a person who resumes the work. Ownership SHALL NOT change either call. The local/OSS realization SHALL no-op both.

#### Scenario: Local authorizer no-ops a suspend and a renew

- **WHEN** `createLocalRunAuthorizer()` gets `suspend(runSession, reason)` or `renew(runSession, auth)`
- **THEN** each resolves `ok` without side effects

## MODIFIED Requirements

### Requirement: RunAuthorizer is the sole constructor of RunSession

`RunAuthorizer.authorize(input)` SHALL be the only seam that produces a
`RunSession`. It takes a single `AuthorizeRunInput` (`{ auth, scope, provenance, frame }`).
It is a gate, as the host-hooks spec defines it, and it returns
`ResultAsync<RunSession, GateFailure>`.

The work that holds a run mandate SHALL end it, whoever made the mandate. A realization
that makes a mandate and a realization that gets a mandate from its caller both own it.
Thus the terminal path of the work SHALL always call `revoke(runSession, reason)`, and a
realization with no mandate SHALL do nothing in `revoke`.

The local realization (`createLocalRunAuthorizer`) issues a durable session with
no remote mint and no revoke. Embedders may provide their
own realization, but workflow bodies SHALL NOT re-authorize; the `RunSession`
rides in workflow input and DBOS replay reconstructs it from input.

#### Scenario: Local authorizer issues a RunSession it does not own

- **WHEN** `createLocalRunAuthorizer().authorize(input)` is called
- **THEN** it gives `ok(runSession)`, with `runSession` carrying the requested `RunFrame`

#### Scenario: The terminal path revokes the mandate of the work

- **GIVEN** a run or a profile that reaches a terminal status
- **WHEN** the body runs its terminal path
- **THEN** it calls `revoke(runSession, reason)` with the run session of its input

#### Scenario: A refused authorization is a value

- **GIVEN** a realization that refuses the authorization
- **WHEN** a caller runs `authorize(input)`
- **THEN** the result is an `err` that carries a `GateFailure`
- **AND** the realization throws nothing

#### Scenario: Workflow bodies do not mint

- **WHEN** `executeAnalysis` or `sandboxStep` executes
- **THEN** no run authorization call is made inside the workflow body

## REMOVED Requirements

### Requirement: RunAuthorizer supports out-of-band revocation by persisted jti
**Reason**: The run ledger keeps the id of the mandate, not the jti of a token, and a token is no longer persisted anywhere.
**Migration**: See the requirement "RunAuthorizer supports out-of-band revocation by the persisted mandate id".
