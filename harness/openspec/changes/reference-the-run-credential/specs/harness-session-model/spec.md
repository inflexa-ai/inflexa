## ADDED Requirements

### Requirement: RunAuthorizer supports out-of-band revocation by the persisted mandate id

`RunAuthorizer` SHALL expose `revokeByMandateId(ref: { mandateId: string; auth: AuthContext }, reason: string)` for paths that hold no `RunAuthorization` — external cancellation, where only the mandate id survives on `cortex_runs`. The `ref` SHALL carry the caller's opaque `AuthContext`; the harness never inspects it. It is a notice. The local/OSS realization SHALL no-op, because it records no reference.

#### Scenario: Local authorizer no-ops

- **WHEN** `createLocalRunAuthorizer().revokeByMandateId({ mandateId, auth }, reason)` is called
- **THEN** it resolves without side effects

#### Scenario: Out-of-band cancel revokes by the mandate id

- **WHEN** the run canceler converges a run whose row carries a `mandate_id`
- **THEN** it calls `revokeByMandateId` with that id and the cancelling session's `auth`, never reconstructing a `RunAuthorization`

### Requirement: The run session is a durable reference, and the authorizer follows the pause of the work

A `RunSession` SHALL hold a durable reference to the run credential, not a time-bound secret, because a run and a profile have no time limit. `RunAuthorizer` SHALL expose `suspend(runSession, reason)`, a notice for work that waits for a person, and `renew(runSession, auth)`, a gate for a person who resumes the work. Ownership SHALL NOT change either call. The local/OSS realization SHALL no-op both.

#### Scenario: Local authorizer no-ops a suspend and a renew

- **WHEN** `createLocalRunAuthorizer()` gets `suspend(runSession, reason)` or `renew(runSession, auth)`
- **THEN** each resolves `ok` without side effects

## REMOVED Requirements

### Requirement: RunAuthorizer supports out-of-band revocation by persisted jti
**Reason**: The run ledger keeps the id of the mandate, not the jti of a token, and a token is no longer persisted anywhere.
**Migration**: See the requirement "RunAuthorizer supports out-of-band revocation by the persisted mandate id".
